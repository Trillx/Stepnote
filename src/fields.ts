// Inspect metadata before reading any editable value or accessible field name.
export function fieldControl(target: Element): Element | null {
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
export function sensitiveField(field: Element): boolean {
  const type = field.getAttribute('type')?.toLowerCase();
  const autocomplete = field.getAttribute('autocomplete')?.toLowerCase().split(/\s+/) ?? [];
  const identity = `${field.getAttribute('name') ?? ''} ${field.id}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  return type === 'password' || autocomplete.some(token => /^(username|current-password|new-password|one-time-code|cc-.+)$/.test(token)) ||
    /password|passwd|passcode|pwd|username|login|secret|token|apikey|otp|onetimecode|verificationcode|securitycode|cardnumber|cardholder|creditcard|ccnumber|ccnum|ccexp|cardexpiry|expmonth|expyear|expiration|cvv|cvc|csc|(?:^|auth|payment)pin/.test(identity);
}
// Visible text without anything typed: field and editable descendants removed.
export function safeText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('input,textarea,select,[contenteditable]').forEach(node => node.remove());
  return copy.textContent?.trim().replace(/\s+/g, ' ') ?? '';
}
export function fieldName(field: Element): string {
  if (sensitiveField(field)) return '';
  const references = (field.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => field.ownerDocument.getElementById(id)).filter((el): el is HTMLElement => !!el);
  const labels = [...field.ownerDocument.querySelectorAll('label')].filter(label => label.htmlFor === field.id && !!field.id || label.contains(field));
  return (field.getAttribute('aria-label') || references.map(safeText).join(' ') || labels.map(safeText).join(' ') || field.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

