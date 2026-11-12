// Native disclosure controls provide keyboard access. All values are plain text.
export function renderJSONView(container, value) {
  const doc = container.ownerDocument;
  function node(key, item, depth) {
    const label = key === null ? '' : JSON.stringify(String(key)) + ': ';
    if (item === null || typeof item !== 'object') {
      const row = doc.createElement('div'); row.className = 'json-leaf';
      const name = doc.createElement('span'); name.textContent = label;
      const text = doc.createElement('span'); text.className = `json-${item === null ? 'null' : typeof item}`; text.textContent = JSON.stringify(item);
      row.append(name, text); return row;
    }
    const details = doc.createElement('details'), summary = doc.createElement('summary');
    const array = Array.isArray(item), entries = Object.entries(item);
    summary.textContent = `${label}${array ? '[ ]' : '{ }'} · ${entries.length} 项`; details.append(summary);
    let built = false;
    const build = () => {
      if (built) return; built = true;
      const children = doc.createElement('div'); children.className = 'json-children';
      if (depth >= 64) children.textContent = '层级较深，请切换原文查看';
      else for (const [name, child] of entries) children.append(node(name, child, depth + 1));
      details.append(children);
    };
    details.addEventListener('toggle', () => { if (details.open) build(); });
    // Used by the explicit Expand all action, never by response content.
    details.expandJSON = () => { build(); details.open = true; };
    if (depth === 0) details.expandJSON();
    return details;
  }
  container.replaceChildren(node(null, value, 0));
}
