/**
 * Reading a requirement out of the case study, rather than copying it.
 *
 * §20.2's safety boundaries needed this first; §7.1's disclosure categories need
 * the same thing. A second copy of the parse would be a second thing that can
 * drift, and the drift would be invisible in exactly the way both callers exist
 * to prevent - each would go on reporting full coverage of its own copy.
 *
 * CLAUDE.md puts it plainly: these numbered subsections contain countable lists,
 * and a count taken from anywhere but the source has been wrong here before.
 */
export class SectionUnreadable extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/**
 * The bullet list under a numbered subsection.
 *
 * @param {string} text     the case study
 * @param {string} section  e.g. "7.1"
 * @param {object} [opts]   { atLeast } - a floor, because a parse that finds
 *   nothing reports perfect coverage of an empty list, and a list that shrinks
 *   is a requirement someone dropped rather than a list that got shorter.
 */
export function bulletsUnder(text, section, { atLeast = 1 } = {}) {
  const heading = new RegExp(`^###\\s+${section.replace('.', '\\.')}\\s`, 'm');
  const start = text.search(heading);
  if (start === -1) {
    throw new SectionUnreadable('section_not_found', `§${section} is not in the case study`);
  }
  const rest = text.slice(start);
  const end = rest.slice(1).search(/^###\s/m);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  const items = [...body.matchAll(/^-\s+(.+?);?\s*$/gm)].map((m) => m[1].replace(/\.$/, ''));
  if (items.length < atLeast) {
    throw new SectionUnreadable('fewer_items_than_required',
      `§${section} yielded ${items.length}, floor is ${atLeast} - a shrinking list is a dropped requirement, and an empty one reports perfect coverage of nothing`);
  }
  return items;
}
