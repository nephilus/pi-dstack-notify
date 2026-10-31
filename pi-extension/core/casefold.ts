import { CASEFOLD_DATA } from './casefold-data.ts';

const mappings = new Map<number, string>(CASEFOLD_DATA);
/** Unicode 15.1 default FULL casefold (C+F, not S/T), complete scalar domain.
 * Identity fallback is against the COMPLETE pinned table, never host lowercase.
 * No NFC/NFKC before or after: source FYIP cleans, casefolds, collapses spaces,
 * then removes terminal sentence punctuation. This comparison is not a grant
 * of publication safety or expansion of the Stage-1 output alphabet. */
export function defaultCaseFold(text: string): string {
  if (typeof text !== 'string') throw new Error('casefold_invalid');
  let result = '';
  for (const scalar of text) result += mappings.get(scalar.codePointAt(0)!) ?? scalar;
  return result;
}
