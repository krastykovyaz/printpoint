try {
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/track-visit");
  } else {
    fetch("/api/track-visit", { method: "POST", keepalive: true });
  }
} catch (error) {
  // Visit tracking is best-effort; never let it block the page.
}

const form = document.querySelector("#order-form");
const fileInput = document.querySelector("#resume");
const dropzone = document.querySelector("#dropzone");
const fileName = document.querySelector("#file-name");
const copies = document.querySelector("#copies");
const message = document.querySelector("#form-message");
const submitButton = document.querySelector("#submit-button");
const priceTotalAmount = document.querySelector("#price-total-amount");
const emailInput = document.querySelector("#email");
const paymentBox = document.querySelector("#payment-box");
const paymentLink = document.querySelector("#payment-link");
const paymentAmount = document.querySelector("#payment-amount");
const paymentProofOverlay = document.querySelector("#payment-proof-overlay");
const paymentProofInput = document.querySelector("#payment-proof");
const paymentProofDropzone = document.querySelector("#payment-proof-dropzone");
const paymentProofFileName = document.querySelector("#payment-proof-file-name");
const locationInput = document.querySelector("#location");
const shareLocationButton = document.querySelector("#share-location-btn");
const locationShareStatus = document.querySelector("#location-share-status");

const linkInput = document.querySelector("#resume-url");
const linkCheckButton = document.querySelector("#check-link");
const linkStatus = document.querySelector("#link-status");

// Online payment through Grandlivre, when the server has it configured (see the meta tags the server adds).
const PAY_MODE = document.querySelector('meta[name="pay-mode"]')?.content === "grandlivre";
const PAY_ORIGIN = document.querySelector('meta[name="grandlivre-origin"]')?.content || "";
const SUBMIT_KEY = PAY_MODE ? "submitPay" : "submit";
const MIN_ORDER = Number(document.querySelector('meta[name="min-copies"]')?.content) || 4;
const MAX_PAGES = 50;
// The server reads the page count from the CV itself; this is what it told us (null until it has).
let documentPages = null;
let pageCountRequest = 0;
copies.min = MIN_ORDER;
copies.value = MIN_ORDER;
const REVOLUT_TAG = "kovyaz";
// The server publishes its price rules (in cents) in the page head; it records the same price on the order.
const PRICE_RULES = (() => {
  const fallback = { page: 50, bulk: 30, after: 10, min: 0 };
  try {
    const rules = JSON.parse(document.querySelector('meta[name="price-rules"]')?.content || "null");
    return rules && ["page", "bulk", "after", "min"].every((key) => Number.isInteger(rules[key])) ? rules : fallback;
  } catch {
    return fallback;
  }
})();

// Shown when the server reports one of these error codes; other errors use the server's text.
const ERROR_KEYS = {
  resume_required: "resumeRequired",
  email_invalid: "emailRequired",
  file_type: "errFileType",
  convert_failed: "errConvert",
  mode_invalid: "errMode",
  link_invalid: "errLinkInvalid",
  link_unreachable: "errLinkUnreachable",
  link_not_pdf: "errLinkNotPdf",
  link_too_large: "errLinkTooLarge",
  link_busy: "errLinkBusy",
  file_too_large: "errFileTooLarge",
  too_many_requests: "errTooMany",
  delivery_failed: "errGeneric",
  unavailable: "errGeneric",
  server_error: "errGeneric"
};

function getSelectedPrintMode() {
  const checked = form.querySelector('input[name="printMode"]:checked');
  return checked ? checked.value : "black-white";
}

function getOrderSize() {
  const copyCount = Math.max(MIN_ORDER, Math.floor(Number(copies.value)) || MIN_ORDER);
  const pageCount = Math.min(MAX_PAGES, Math.max(1, documentPages || 1));
  return { copyCount, pageCount, totalPages: copyCount * pageCount };
}

// Black & white is the only mode, so printMode does not change the price.
function calculateTotal(totalPages, _printMode) {
  const standardCount = Math.min(totalPages, PRICE_RULES.after);
  const extraCount = Math.max(0, totalPages - PRICE_RULES.after);
  return Math.max(PRICE_RULES.min, standardCount * PRICE_RULES.page + extraCount * PRICE_RULES.bulk) / 100;
}

function currentAmount() {
  return calculateTotal(getOrderSize().totalPages, getSelectedPrintMode()).toFixed(2);
}

function updatePriceSummary() {
  if (!priceTotalAmount) return;
  const { copyCount, pageCount, totalPages } = getOrderSize();
  const waiting = documentPages === null && (fileInput.files.length > 0 || linkInput.value.trim().length > 0);
  priceTotalAmount.textContent = waiting ? "…" : `€${currentAmount()} (${copyCount} × ${pageCount} = ${totalPages})`;
}

function updatePaymentPrompt() {
  if (!paymentBox || PAY_MODE) return;
  const isValidEmail = emailInput.checkValidity() && emailInput.value.trim().length > 0;
  if (isValidEmail) emailInput.classList.remove("has-error");
  paymentBox.hidden = !isValidEmail;
  if (!isValidEmail) return;

  paymentAmount.textContent = `€${currentAmount()}`;
  paymentLink.href = `https://revolut.me/${REVOLUT_TAG}`;
}

function showFile(file) {
  if (!file) {
    fileName.textContent = "";
    dropzone.classList.remove("has-file");
    documentPages = null;
    pageCountRequest += 1;
    return;
  }
  fileName.textContent = `${window.i18n.t("attachedPrefix")} ${file.name}`;
  dropzone.classList.add("has-file");
  dropzone.classList.remove("has-error");
  loadPageCount(file);
  openAfterResume();
}

// The price depends on the number of pages, which the server reads from the file (nothing is kept).
async function loadPageCount(file) {
  const request = ++pageCountRequest;
  documentPages = null;
  refreshOrderSummary();
  try {
    const body = new FormData();
    body.append("resume", file, file.name);
    const response = await fetch("/api/inspect", { method: "POST", body });
    const result = await response.json().catch(() => ({}));
    if (request !== pageCountRequest) return; // another file was chosen meanwhile
    documentPages = response.ok && Number.isInteger(result.pages) ? result.pages : 1;
  } catch (error) {
    if (request !== pageCountRequest) return;
    documentPages = 1; // the server works the real count out again when the order is sent
  }
  refreshOrderSummary();
}

function showPaymentProofFile(file) {
  if (!paymentProofFileName || !paymentProofDropzone) return;
  if (!file) {
    paymentProofFileName.textContent = "";
    paymentProofDropzone.classList.remove("has-file");
    return;
  }
  paymentProofFileName.textContent = `${window.i18n.t("attachedPrefix")} ${file.name}`;
  paymentProofDropzone.classList.add("has-file");
}

function setupDropzone(dropzoneEl, inputEl, onFile) {
  if (!dropzoneEl || !inputEl) return;
  inputEl.addEventListener("change", () => onFile(inputEl.files[0]));
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzoneEl.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzoneEl.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropzoneEl.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzoneEl.classList.remove("is-dragging");
    });
  });
  dropzoneEl.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    inputEl.files = transfer.files;
    onFile(file);
  });
}

function openPaymentProofModal() {
  if (paymentProofOverlay) paymentProofOverlay.hidden = false;
}

function closePaymentProofModal() {
  if (paymentProofOverlay) paymentProofOverlay.hidden = true;
}

function refreshOrderSummary() {
  updatePriceSummary();
  updatePaymentPrompt();
}

function updateCopies(amount) {
  const next = Math.min(100, Math.max(MIN_ORDER, Number(copies.value || MIN_ORDER) + amount));
  copies.value = next;
  refreshOrderSummary();
}

document.querySelector("#decrease").addEventListener("click", () => updateCopies(-1));
document.querySelector("#increase").addEventListener("click", () => updateCopies(1));
copies.addEventListener("input", refreshOrderSummary);
emailInput.addEventListener("input", updatePaymentPrompt);
emailInput.addEventListener("blur", updatePaymentPrompt);
form.querySelectorAll('input[name="printMode"]').forEach((radio) => {
  radio.addEventListener("change", refreshOrderSummary);
});
refreshOrderSummary();

setupDropzone(dropzone, fileInput, showFile);
setupDropzone(paymentProofDropzone, paymentProofInput, showPaymentProofFile);

function shareExactLocation() {
  if (!locationShareStatus) return;
  locationShareStatus.textContent = "";
  locationShareStatus.className = "location-share-status";

  if (!navigator.geolocation) {
    locationShareStatus.textContent = window.i18n.t("locationShareUnsupported");
    locationShareStatus.classList.add("error");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;
      const existing = locationInput.value.trim();
      locationInput.value = existing ? `${existing} — ${mapsLink}` : mapsLink;
      locationShareStatus.textContent = window.i18n.t("locationShareSuccess");
      locationShareStatus.classList.add("success");
    },
    () => {
      locationShareStatus.textContent = window.i18n.t("locationShareError");
      locationShareStatus.classList.add("error");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

if (shareLocationButton) {
  shareLocationButton.addEventListener("click", shareExactLocation);
}

let hasClickedPayLink = false;

if (paymentLink) {
  paymentLink.addEventListener("click", () => {
    hasClickedPayLink = true;
    openPaymentProofModal();
  });
}

let hasPromptedForReceipt = false;
let paymentPending = false;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  message.className = "form-message";

  if (!fileInput.files.length && !linkInput.value.trim()) {
    message.textContent = window.i18n.t("resumeRequired");
    message.classList.add("error");
    dropzone.classList.add("has-error");
    dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (!emailInput.checkValidity() || emailInput.value.trim().length === 0) {
    message.textContent = window.i18n.t("emailRequired");
    message.classList.add("error");
    emailInput.classList.add("has-error");
    emailInput.focus();
    return;
  }
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const hasProof = Boolean(paymentProofInput && paymentProofInput.files && paymentProofInput.files.length > 0);
  const hasConfirmedPayment = hasProof && hasClickedPayLink;
  if (!PAY_MODE && !hasConfirmedPayment && !hasPromptedForReceipt) {
    hasPromptedForReceipt = true;
    openPaymentProofModal();
    message.textContent = window.i18n.t("receiptPrompt");
    message.classList.add("error");
    return;
  }

  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = window.i18n.t("sending");

  try {
    const response = await fetch("/api/orders", { method: "POST", body: new FormData(form) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const key = ERROR_KEYS[result.code];
      throw new Error(key ? window.i18n.t(key) : result.error || window.i18n.t("errGeneric"));
    }

    if (result.mode === "grandlivre") {
      // The order exists at the server's price; the customer now pays through the widget.
      paymentPending = true;
      startPayment(result);
      return;
    }
    if (result.mode === "revolut") {
      // Online payment was unavailable: the order is saved, and the customer pays by Revolut.
      resetOrderForm();
      showFallbackPayment(result);
      return;
    }

    message.textContent = window.i18n.t("orderSuccess").replace("{code}", result.orderCode);
    message.classList.add("success");
    resetOrderForm();
  } catch (error) {
    // A TypeError here means the request itself failed (offline, connection dropped).
    message.textContent = error instanceof TypeError ? window.i18n.t("errGeneric") : error.message;
    message.classList.add("error");
  } finally {
    submitButton.disabled = paymentPending;
    submitButton.querySelector("span").textContent = window.i18n.t(SUBMIT_KEY);
  }
});

function resetOrderForm() {
  form.reset();
  closeSteps();
  copies.value = MIN_ORDER;
  documentPages = null;
  pageCountRequest += 1;
  showFile(null);
  setLinkStatus("");
  showPaymentProofFile(null);
  closePaymentProofModal();
  hasPromptedForReceipt = false;
  hasClickedPayLink = false;
  refreshOrderSummary();
}

// Handoff from tsech.online: the page that opened this window can send its finished CV straight into
// the form. Only that one origin is trusted, only from the window that opened us, and nothing is
// uploaded until the customer submits the order.
const HANDOFF_ORIGIN = document.querySelector('meta[name="handoff-origin"]')?.content || "https://tsech.online";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function acceptHandoff(data) {
  const blob = data?.file;
  if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_FILE_BYTES) return;
  const signature = await blob.slice(0, 5).text();
  if (signature !== "%PDF-") return;

  const rawName = typeof data.filename === "string" ? data.filename : "";
  const baseName = rawName.split(/[\\/]/).pop().replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 80);
  const file = new File([blob], `${baseName || "resume"}.pdf`, { type: "application/pdf" });

  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  showFile(file);
  linkInput.value = "";
  setLinkStatus("");
  emailInput?.focus();
}

window.addEventListener("message", (event) => {
  if (!window.opener || event.source !== window.opener || event.origin !== HANDOFF_ORIGIN) return;
  if (event.data?.type !== "printpoint-cv") return;
  acceptHandoff(event.data);
});

// Tell the opener we are ready; the browser delivers this only if the opener really is HANDOFF_ORIGIN.
if (window.opener) {
  try {
    window.opener.postMessage({ type: "printpoint-ready" }, HANDOFF_ORIGIN);
  } catch (error) {
    // No usable opener: the customer attaches the file by hand as usual.
  }
}

// A pasted link is the alternative to an upload: the server fetches it when the order is sent.
// "Check" lets the customer see right away whether the link works; nothing is kept from the check.
function setLinkStatus(text, kind = "") {
  linkStatus.textContent = text;
  linkStatus.className = `link-status${kind ? ` ${kind}` : ""}`;
}

async function checkLink() {
  const url = linkInput.value.trim();
  if (!url) {
    setLinkStatus("");
    return;
  }
  linkCheckButton.disabled = true;
  setLinkStatus(window.i18n.t("linkChecking"));
  try {
    const response = await fetch("/api/check-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const result = await response.json().catch(() => ({}));
    if (linkInput.value.trim() !== url) return; // edited while checking; the result is stale
    if (!response.ok) {
      const key = ERROR_KEYS[result.code];
      setLinkStatus(key ? window.i18n.t(key) : window.i18n.t("errGeneric"), "error");
      return;
    }
    const kb = Math.max(1, Math.round(result.size / 1024));
    setLinkStatus(`${window.i18n.t("linkOk").replace("{name}", result.filename)} (${kb} KB)`, "ok");
    documentPages = Number.isInteger(result.pages) ? result.pages : 1;
    refreshOrderSummary();
    openAfterResume();
  } catch (error) {
    setLinkStatus(window.i18n.t("errGeneric"), "error");
  } finally {
    linkCheckButton.disabled = false;
  }
}

linkCheckButton.addEventListener("click", checkLink);
linkInput.addEventListener("change", checkLink);
linkInput.addEventListener("input", () => {
  setLinkStatus("");
  documentPages = null; // a new link has to be checked before its page count is known
  pageCountRequest += 1;
  refreshOrderSummary();
  if (linkInput.value.trim() && fileInput.files.length) {
    fileInput.value = "";
    showFile(null);
  }
});
// Choosing a file replaces any pasted link, so the order never carries both.
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) {
    linkInput.value = "";
    setLinkStatus("");
  }
});
dropzone.addEventListener("drop", () => {
  linkInput.value = "";
  setLinkStatus("");
});

// ---- Paying through Grandlivre ----------------------------------------------------------------------
// The order is created when the customer presses the button; the server prices it and makes its own payment link.
// "Payment reported" from the widget is only the customer's word: the page shows "paid" when the server says so,
// and the server says so only after the payment is confirmed.
const PENDING_KEY = "printcv.pendingOrder";
const payPanel = document.querySelector("#pay-panel");
const payTitle = document.querySelector("#pay-title");
const payStatus = document.querySelector("#pay-status");
const payWidget = document.querySelector("#pay-widget");
const payFallbackLink = document.querySelector("#pay-fallback-link");
const payRestart = document.querySelector("#pay-restart");

let pending = null; // { code, key, amount }
let reportedLocally = false;
let pollTimer = null;
let widgetMounted = false;
let shownState = null;

if (PAY_MODE) {
  // The language loader fills the button from this key, now and whenever the language changes.
  submitButton.querySelector("span").dataset.i18n = SUBMIT_KEY;
  submitButton.querySelector("span").textContent = window.i18n.t(SUBMIT_KEY);
}

function savePending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...pending, savedAt: Date.now() }));
  } catch (error) {
    // Without storage the status simply is not restored after a reload.
  }
}

function loadPending() {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_KEY));
    if (saved && saved.code && saved.key && Date.now() - saved.savedAt < 48 * 60 * 60 * 1000) return saved;
  } catch (error) {
    // Nothing usable stored.
  }
  return null;
}

function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch (error) {
    // Nothing to clear.
  }
}

function setLocked(locked) {
  form.classList.toggle("is-locked", locked);
  for (const element of form.elements) {
    if (element !== payRestart) element.disabled = locked;
  }
}

function fillText(key) {
  return window.i18n.t(key).replaceAll("{code}", pending.code).replaceAll("{amount}", `€${pending.amount}`);
}

function renderPay(state) {
  if (!pending) return;
  const shown = state === "awaiting" && reportedLocally ? "confirming" : state;
  shownState = shown;
  const texts = {
    awaiting: ["payWaiting", ""],
    confirming: ["payReported", ""],
    paid: ["payPaid", "ok"],
    problem: ["payProblem", "error"]
  };
  const [key, kind] = texts[shown] || texts.problem;
  payPanel.hidden = false;
  payTitle.textContent = `${pending.code} · €${pending.amount}`;
  payStatus.textContent = fillText(key);
  payStatus.className = `pay-status${kind ? ` ${kind}` : ""}`;
  payFallbackLink.hidden = true;
  payRestart.hidden = shown === "confirming";
  if (shown === "paid") {
    clearPending();
    payWidget.textContent = "";
    closePayWindow();
  }
}

// Grandlivre's widget.js cannot be used here (it is served so that other sites may not load it), and it only
// adds a button around the payment page anyway. So the page makes its own button and shows that payment page
// in a frame; the page itself says "I paid" with the same message the widget would pass on.
let payWindow = null;

function closePayWindow() {
  if (payWindow) payWindow.remove();
  payWindow = null;
  document.removeEventListener("keydown", onPayKey);
}

function onPayKey(event) {
  if (event.key === "Escape") closePayWindow();
}

function openPayWindow(token) {
  closePayWindow();
  const overlay = document.createElement("div");
  overlay.className = "pay-overlay";
  const box = document.createElement("div");
  box.className = "pay-box";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "pay-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close");
  const frame = document.createElement("iframe");
  frame.src = `${PAY_ORIGIN}/pay/${encodeURIComponent(token)}?ref=${encodeURIComponent(pending.code)}`;
  frame.title = "Payment";
  frame.allow = "clipboard-write";
  close.addEventListener("click", closePayWindow);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closePayWindow();
  });
  box.append(close, frame);
  overlay.append(box);
  document.body.append(overlay);
  payWindow = overlay;
  document.addEventListener("keydown", onPayKey);
}

function mountWidget(token, autoOpen) {
  payWidget.textContent = "";
  widgetMounted = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pay-open";
  button.textContent = fillText("payNow");
  button.addEventListener("click", () => openPayWindow(token));
  payWidget.append(button);
  if (autoOpen) openPayWindow(token);
}

async function pollStatus(first = false) {
  if (!pending) return;
  clearTimeout(pollTimer);
  let state = null;
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(pending.code)}/status${first ? "?reload=1" : ""}`, {
      headers: { "X-Order-Key": pending.key }
    });
    if (response.status === 404) {
      endPending();
      return;
    }
    const data = await response.json();
    state = data.state;
    if (state === "expired") {
      endPending();
      return;
    }
    if (state === "awaiting" && data.token && !widgetMounted) mountWidget(data.token, false);
    renderPay(state);
  } catch (error) {
    // Offline or the server restarted: try again shortly.
  }
  if (state !== "paid") pollTimer = setTimeout(pollStatus, 8000);
}

function startPayment(result) {
  pending = { code: result.orderCode, key: result.statusKey, amount: result.amount };
  reportedLocally = false;
  savePending();
  setLocked(true);
  renderPay("awaiting");
  mountWidget(result.token, true);
  pollTimer = setTimeout(pollStatus, 8000);
  payPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showFallbackPayment(result) {
  pending = { code: result.orderCode, key: "", amount: result.amount };
  shownState = "manual";
  payPanel.hidden = false;
  payTitle.textContent = `${pending.code} · €${pending.amount}`;
  payStatus.textContent = fillText("payFallback");
  payStatus.className = "pay-status";
  payWidget.textContent = "";
  payFallbackLink.href = `https://revolut.me/${REVOLUT_TAG}`;
  payFallbackLink.hidden = false;
  payRestart.hidden = false;
  payPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Leaves the payment view: the form is free again for a new order.
function endPending() {
  clearTimeout(pollTimer);
  pending = null;
  reportedLocally = false;
  widgetMounted = false;
  shownState = null;
  paymentPending = false;
  clearPending();
  closePayWindow();
  payWidget.textContent = "";
  payPanel.hidden = true;
  payFallbackLink.hidden = true;
  payStatus.textContent = "";
  setLocked(false);
  form.classList.remove("is-resumed");
  submitButton.disabled = false;
  resetOrderForm();
}

payRestart.addEventListener("click", async () => {
  if (pending && pending.key && shownState === "awaiting") {
    // An order that was never paid is dropped, with its CV and payment link.
    try {
      await fetch(`/api/orders/${encodeURIComponent(pending.code)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: pending.key })
      });
    } catch (error) {
      // The server also removes unpaid orders by itself after a day.
    }
  }
  endPending();
});

if (PAY_MODE) {
  // "I paid" from the payment window: show that we are confirming, and ask the server straight away.
  window.addEventListener("message", (event) => {
    if (event.origin !== PAY_ORIGIN || !pending) return;
    const data = event.data;
    if (!data || data.type !== "grandlivre-pay" || data.ref !== pending.code) return;
    reportedLocally = true;
    renderPay("confirming");
    pollStatus();
  });

  // After a reload, pick the order up again where it stood.
  const saved = loadPending();
  if (saved) {
    pending = { code: saved.code, key: saved.key, amount: saved.amount };
    paymentPending = true;
    setLocked(true);
    form.classList.add("is-resumed");
    pollStatus(true);
  }
}

// ---- The form opens one point at a time -----------------------------------------------------------
// Attach a resume -> copies, print mode and price open -> the email field -> after a valid email the phone,
// then the pickup location, then the send button, each floating in a moment after the one before.
// Required points wait for the customer; the optional ones follow on their own so nobody is blocked.
const stepElements = [...form.querySelectorAll("[data-step]")];
const reduceMotion = Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
let openLevel = 1;
let stepTimers = [];

function renderSteps(animate) {
  for (const element of stepElements) {
    const open = Number(element.dataset.step) <= openLevel;
    const wasClosed = element.classList.contains("step-pending");
    element.classList.toggle("step-pending", !open);
    if (open && wasClosed && animate && !reduceMotion) {
      element.classList.remove("step-in");
      void element.offsetWidth; // restart the animation
      element.classList.add("step-in");
    }
  }
}

function openStep(level, delay = 0) {
  const run = () => {
    if (level <= openLevel) return;
    openLevel = level;
    renderSteps(true);
    // The email field is the next thing to fill in: put the cursor there unless the customer is elsewhere.
    if (level === 3 && document.activeElement === document.body) emailInput.focus({ preventScroll: true });
  };
  if (delay && !reduceMotion) stepTimers.push(setTimeout(run, delay));
  else run();
}

function openAfterResume() {
  openStep(2);
  openStep(3, 450);
  openAfterEmail();
}

function openAfterEmail() {
  const emailOk = emailInput.value.trim().length > 0 && emailInput.checkValidity();
  if (!emailOk || openLevel < 3) return;
  openStep(4);
  openStep(5, 450);
  openStep(6, 900);
}

// A new order starts from the first point again.
function closeSteps() {
  stepTimers.forEach(clearTimeout);
  stepTimers = [];
  openLevel = 1;
  renderSteps(false);
}

emailInput.addEventListener("input", openAfterEmail);
emailInput.addEventListener("change", openAfterEmail);
renderSteps(false);
// A form the browser restored (back button, autofill) may already have a resume and an email.
if (fileInput.files.length > 0) openAfterResume();

// Green light on the main page: asks the server whether the print agent and the printer are ready right now.
const PRINTER_STATUS_KEYS = { online: "printerOnline", attention: "printerAttention", offline: "printerOffline" };
async function refreshPrinterStatus() {
  const box = document.getElementById("printer-status");
  const label = document.getElementById("printer-status-text");
  if (!box || !label) return;
  let state = "offline";
  try {
    const response = await fetch("/api/printer-status", { cache: "no-store" });
    const result = await response.json();
    if (Object.hasOwn(PRINTER_STATUS_KEYS, result.status)) state = result.status;
  } catch {
    // Network trouble on the visitor's side: show offline rather than a stale green light.
  }
  box.dataset.state = state;
  // Not online: warn before the order is sent and again above the payment, so nobody pays expecting it right away.
  for (const notice of document.querySelectorAll(".offline-notice")) notice.hidden = state === "online";
  label.dataset.i18n = PRINTER_STATUS_KEYS[state];
  label.textContent = t(PRINTER_STATUS_KEYS[state]);
}
refreshPrinterStatus();
setInterval(() => {
  if (!document.hidden) refreshPrinterStatus();
}, 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshPrinterStatus();
});
