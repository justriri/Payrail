// Progressive enhancement only: copy buttons for the command blocks. The page is complete without JavaScript.
document.querySelectorAll('button.copy').forEach((b) => {
  b.addEventListener('click', async () => {
    const el = document.getElementById(b.dataset.copy);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.innerText.trim());
      b.textContent = 'Copied';
    } catch {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      b.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 1800);
  });
});
