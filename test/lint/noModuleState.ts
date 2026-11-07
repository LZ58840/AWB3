// The "no module state" rule (plan 5.3, 7.8): a request handler keeps no state in a module variable, because parallel requests run on
// separate instances and a variable is not shared. Plan 7.8 puts the rule in `npm run lint`; the repo has no eslint, so this is a scan of the text.
//
// A top-level declaration is a line that starts in column 0. The scan reports:
//   - `let` and `var` at the top level;
//   - `const NAME = new Map(` (or Set, WeakMap, WeakSet), `= []` or `= {}` at the top level, when the same file changes NAME later:
//     NAME.set(, .add(, .push(, .delete(, .clear(, ..., NAME[key] =, NAME.key =, Object.assign(NAME.
// shortcut: this is a text scan, not a parser. A container that another file changes, one that starts with elements, and state that hides in a
// class, a closure at the top level or `globalThis` are not seen. Move to the TypeScript compiler API if the rule must be that strict.
const CONTAINER = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b[^=\n]*=\s*(?:new\s+(?:Weak)?(?:Map|Set)\s*[(<]|\[\s*\]|\{\s*\})/;
const VARIABLE = /^(?:export\s+)?(let|var)\s+([A-Za-z_$][\w$]*)/;

/** A change of NAME in the text: a mutating method, an assignment to an index or a property, or Object.assign. NAME is not a property of another object. */
const changes = (name: string) => {
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(
    `(?<![\\w$.])${n}(?:\\.(?:set|add|push|pop|shift|unshift|splice|delete|clear|sort|reverse|fill|copyWithin)\\(|\\[[^\\]\\n]*\\]\\s*=(?!=)|\\.[\\w$]+\\s*=(?!=))|Object\\.assign\\(\\s*${n}(?![\\w$])`,
  );
};

/** The module state in the text of a file, one finding for each. */
export function moduleState(file: string, text: string): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const variable = VARIABLE.exec(line);
    if (variable) return [`${file}:${i + 1}: top-level ${variable[1]} ${variable[2]}`];
    const container = CONTAINER.exec(line);
    const others = lines.filter((_, j) => j !== i).join('\n');
    return container && changes(container[1]!).test(others) ? [`${file}:${i + 1}: top-level container ${container[1]} that the file changes`] : [];
  });
}
