const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'svg', 'math', 'img', 'video', 'audio', 'noscript', 'template']);
const KEEP = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'blockquote', 'div', 'span', 'pre', 'code', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SAFE_URL = /^(https?:|mailto:)/i;

/** Lọc HTML bằng allow-list: dựng cây mới trong tài liệu trơ, không giữ lại thuộc tính nào ngoài `href` an toàn. */
export function sanitizeHtml(html: string, options: {links?: boolean} = {}): string {
 const links = options.links !== false;
 const src = document.implementation.createHTMLDocument('').body;
 src.innerHTML = html;
 const out = document.implementation.createHTMLDocument('').body;
 const walk = (from: Node, to: Node): void => {
  for (const node of Array.from(from.childNodes)) {
   if (node.nodeType === 3) { to.appendChild(out.ownerDocument.createTextNode(node.textContent ?? '')); continue; }
   if (node.nodeType !== 1) continue;
   const el = node as Element;
   const tag = el.tagName.toLowerCase();
   if (DROP.has(tag)) continue;
   if (!KEEP.has(tag)) { walk(el, to); continue; }
   if (tag === 'a') {
    const href = (el.getAttribute('href') ?? '').trim();
    if (!links || !SAFE_URL.test(href)) { walk(el, to); continue; }
    const a = out.ownerDocument.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    walk(el, a);
    to.appendChild(a);
    continue;
   }
   const copy = out.ownerDocument.createElement(tag);
   walk(el, copy);
   to.appendChild(copy);
  }
 };
 walk(src, out);
 return out.innerHTML;
}
