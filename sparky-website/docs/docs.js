const sidebar = document.querySelector('.docs-sidebar');
const desktop = matchMedia('(min-width: 761px)');
const syncSidebar = () => { sidebar.open = desktop.matches; };
syncSidebar();
desktop.addEventListener('change', syncSidebar);
const search = document.querySelector('#guide-search');
const groups = [...document.querySelectorAll('.nav-group')];
search.addEventListener('input', () => {
  const query = search.value.trim().toLowerCase();
  let count = 0;
  for (const group of groups) {
    let matches = 0;
    for (const item of group.querySelectorAll('li')) {
      item.hidden = !item.textContent.toLowerCase().includes(query);
      if (!item.hidden) matches++;
    }
    group.hidden = matches === 0;
    count += matches;
  }
  document.querySelector('.search-empty').hidden = count > 0;
  document.querySelector('#search-status').textContent = query ? `${count} guides found` : '';
});
document.querySelectorAll('.copy-prompt').forEach(button => {
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  button.after(status);
  button.addEventListener('click', async () => {
    status.textContent = '';
    try {
      await navigator.clipboard.writeText(button.closest('.docs-code-block').querySelector('.docs-code-body').innerText.trim());
      button.textContent = 'Copied';
      status.textContent = 'Example prompt copied to clipboard.';
    } catch {
      button.textContent = 'Select text to copy';
      status.textContent = 'Could not copy. Select the example text and copy it manually.';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2500);
  });
});
const headings = [...document.querySelectorAll('main h2[id]')];
const toc = [...document.querySelectorAll('.docs-toc a')];
function updateToc() {
  const current = headings.filter(heading => heading.getBoundingClientRect().top <= 160).at(-1) || headings[0];
  for (const link of toc) {
    if (link.hash === `#${current?.id}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
let scheduled = false;
addEventListener('scroll', () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { updateToc(); scheduled = false; });
}, { passive: true });
updateToc();
