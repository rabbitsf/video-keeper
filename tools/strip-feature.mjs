// Removes feature blocks from source text for builds that leave a feature out (tools/build-chrome-store.mjs).
// A block is the lines between a "#if <feature>" marker line and the next "#endif" marker line, both
// removed with it. Markers sit on their own line as a comment in the file's own syntax:
//   JS: // #if youtube      HTML: <!-- #if youtube -->      CSS: /* #if youtube */
// Markers are only comments, so unbuilt sources (unpacked Chrome, Firefox) run everything. No nesting.

const MARKER = /^\s*(?:\/\/|<!--|\/\*)\s*#(if\s+([\w-]+)|endif)\s*(?:-->|\*\/)?\s*$/;

export function stripFeature(text, feature) {
  const out = [];
  let open = null; // { name, line } of the block we are in
  text.split('\n').forEach((line, i) => {
    const m = MARKER.exec(line);
    if (m && m[2]) {
      if (open) throw new Error(`line ${i + 1}: nested #if inside #if ${open.name} (line ${open.line})`);
      open = { name: m[2], line: i + 1 };
      if (open.name !== feature) out.push(line);
      return;
    }
    if (m) {
      if (!open) throw new Error(`line ${i + 1}: #endif without #if`);
      if (open.name !== feature) out.push(line);
      open = null;
      return;
    }
    if (!open || open.name !== feature) out.push(line);
  });
  if (open) throw new Error(`line ${open.line}: unclosed #if ${open.name}`);
  return out.join('\n');
}
