import { execa } from 'execa';
import ffmpeg from 'fluent-ffmpeg';
import * as nodeFs from 'node:fs/promises';
import * as nodeProcess from 'node:process';
import * as radash from 'radash';
import * as uuid from 'uuid';
import { z } from 'zod';

import { processRequests } from '@mediabot/broker/processRequests';

import { processor } from './api';
import { env, log, prisma, redis } from './deps';

type Result = z.infer<(typeof processor)['resultSchema']>;

export const main = async (process: NodeJS.Process, abortSignal: AbortSignal) => await radash.defer(async defer => {
    await processRequests(
        {
            prisma,
            redis,
            log,
        },
        processor,
        async ({ key, source }) => await radash.defer(async defer => {
            log.debug({ source }, 'processing');

            const tmpDir = `${ nodeProcess.cwd() }/tmp/${ key.replace(/\//g, '+') }`;
            await nodeFs.mkdir(tmpDir, { recursive: true });
            defer(async () => nodeFs.rm(tmpDir, { recursive: true, force: true }));

            const process = await execa(env.YTDLP_PATH, [
                '--no-playlist',
                '--print-json',
                '--no-progress',
                '-f', '(b[ext=mp4])[filesize<50M]/(bv[ext=mp4]+ba[ext=m4a])[filesize<50M]/b/bv',
                '-o', '%(title).200s.%(ext)s',
                '--remux-video', 'mp4',
                '--ppa', 'Merger+FFmpeg:-movflags faststart',
                source,
            ], {
                cwd: tmpDir,
                stdout: 'pipe',
                stderr: 'pipe',
            });

            if (process.exitCode !== 0) {
                log.error({
                    exitCode: process.exitCode,
                    stdout: process.stdout,
                    stderr: process.stderr,
                }, 'ytdlp failed');

                throw new Error('ytdlp failed');
            }

            const rawOutput = JSON.parse(process.stdout);

            log.debug({
                output: rawOutput,
            }, 'ytdlp output');

            const output = z.object({
                title: z.string(),
                webpage_url: z.string(),

                filename: z.string(),

                width: z.coerce.number().optional(),
                height: z.coerce.number().optional(),
                duration: z.coerce.number().optional(),
            }).parse(
                rawOutput,
            );

            const videoId = uuid.v4();
            const ref = `ytdlp:video:${ videoId }`;

            let size = output.width && output.height
                ? {
                    width: output.width,
                    height: output.height,
                }
                : undefined;

            if (size === undefined) {
                size = await new Promise(resolve => {
                    ffmpeg.ffprobe(`${ tmpDir }/${ output.filename }`, (err, metadata) => {
                        if (err) {
                            log.error({
                                file: `${ tmpDir }/${ output.filename }`,
                                err,
                            }, 'ffprobe failed');
                        }

                        const videoStream = metadata?.streams.find(
                            stream => stream.codec_type === 'video',
                        );

                        if (videoStream?.width && videoStream?.height) {
                            resolve({
                                width: videoStream.width,
                                height: videoStream.height,
                            });
                        } else {
                            resolve(undefined);
                        }
                    });
                });
            }

            await redis.client.setex(
                `${ redis.prefix }:${ ref }`, 120,
                await nodeFs.readFile(`${ tmpDir }/${ output.filename }`),
            );

            return {
                title: output.title,
                url: output.webpage_url,

                media: [
                    {
                        type: 'video',
                        ref,
                        size,
                        duration: output.duration,
                    },
                ],
            } satisfies Result;
        }),
        {
            abortSignal,
            concurrency: 16,
            cacheTimeout: 60,
        },
    );

    return 0;
});