const mermaid = globalThis.mermaid;

try {
  mermaid?.initialize?.({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict'
  });
} catch {
  // ignore
}

function postTo(source, message) {
  try {
    source?.postMessage?.({ __from: 'mermaid_sandbox', ...(message || {}) }, '*');
  } catch {
    // ignore
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'render_mermaid') return;

  const id = typeof msg.id === 'string' ? msg.id : '';
  const code = typeof msg.code === 'string' ? msg.code : '';
  if (!id) return;

  Promise.resolve()
    .then(async () => {
      if (!mermaid?.render) throw new Error('mermaid is not available');
      const { svg } = await mermaid.render(`mmd-${id}`, code);
      postTo(event.source, { type: 'render_mermaid_result', id, svg });
    })
    .catch((e) => {
      postTo(event.source, { type: 'render_mermaid_error', id, error: String(e) });
    });
});

postTo(parent, { type: 'mermaid_ready' });

