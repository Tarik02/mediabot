import { z } from 'zod';

export const env = z.intersection(
    z.object({
        BOT_TOKEN: z.string(),
        TEMPORARY_CHAT_ID: z.coerce.number(),
    }),
    z.union([
        z.object({
            BOT_MODE: z.literal('polling').default('polling'),
        }),
        z.object({
            BOT_MODE: z.literal('webhook'),
            BOT_WEBHOOK_PORT: z.coerce.number().default(80),
            BOT_WEBHOOK_PATH: z.string().default('/'),
        }),
    ]),
).parse(
    process.env,
);