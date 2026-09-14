/**
 * The media types this product handles, derived from the schema rather than
 * written down again.
 *
 * It was previously a literal array in two modules. They agreed, and nothing
 * checked that they did or that either matched the schema's own enum — the same
 * shape as the surface vocabulary that used to exist in four copies.
 *
 * It reads common.schema.json rather than the capability declaration. Which
 * formats the product handles is a fact about product scope that the status
 * rules need too; having status reach into the capability contract for it
 * pointed the dependency the wrong way.
 */
import { readFileSync } from 'node:fs';

const common = JSON.parse(
  readFileSync(new URL('../schemas/v1/common.schema.json', import.meta.url), 'utf8'),
);

export const SUPPORTED_MEDIA_TYPES = common.$defs.mediaType.enum;
