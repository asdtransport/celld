import { z } from "zod";
export const ItemInput = z.object({ name: z.string().min(1), note: z.string().optional() });
export type ItemInput = z.infer<typeof ItemInput>;
