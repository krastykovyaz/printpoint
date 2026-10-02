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

const pagesInput = document.querySelector("#pages");

const MIN_ORDER = 4;
const MAX_PAGES = 50;
const BULK_THRESHOLD = 10;
const REVOLUT_TAG = "kovyaz";
// Keep in sync with RATES_CENTS in server.js, which sets the price recorded on the order.
const RATES = {
  "black-white": { standard: 0.5, bulk: 0.3 },
  color: { standard: 0.6, bulk: 0.4 }
};

// Shown when the server reports one of these error codes; other errors use the server's text.
const ERROR_KEYS = {
  resume_required: "resumeRequired",
  email_invalid: "emailRequired",
  file_type: "errFileType",
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
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.floor(Number(pagesInput && pagesInput.value)) || 1));
  return { copyCount, pageCount, totalPages: copyCount * pageCount };
}

function calculateTotal(totalPages, printMode) {
  const rates = Object.hasOwn(RATES, printMode) ? RATES[printMode] : RATES["black-white"];
  const standardCount = Math.min(totalPages, BULK_THRESHOLD);
  const extraCount = Math.max(0, totalPages - BULK_THRESHOLD);
  return standardCount * rates.standard + extraCount * rates.bulk;
}

function currentAmount() {
  return calculateTotal(getOrderSize().totalPages, getSelectedPrintMode()).toFixed(2);
}

function updatePriceSummary() {
  if (!priceTotalAmount) return;
  const { copyCount, pageCount, totalPages } = getOrderSize();
  priceTotalAmount.textContent = `€${currentAmount()} (${copyCount} × ${pageCount} = ${totalPages})`;
}

function updatePaymentPrompt() {
  if (!paymentBox) return;
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
    return;
  }
  fileName.textContent = `${window.i18n.t("attachedPrefix")} ${file.name}`;
  dropzone.classList.add("has-file");
  dropzone.classList.remove("has-error");
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
if (pagesInput) pagesInput.addEventListener("input", refreshOrderSummary);
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  message.className = "form-message";

  if (!fileInput.files.length) {
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
  if (!hasConfirmedPayment && !hasPromptedForReceipt) {
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

    message.textContent = window.i18n.t("orderSuccess").replace("{code}", result.orderCode);
    message.classList.add("success");
    form.reset();
    copies.value = MIN_ORDER;
    if (pagesInput) pagesInput.value = 1;
    showFile(null);
    showPaymentProofFile(null);
    closePaymentProofModal();
    hasPromptedForReceipt = false;
    hasClickedPayLink = false;
    refreshOrderSummary();
  } catch (error) {
    // A TypeError here means the request itself failed (offline, connection dropped).
    message.textContent = error instanceof TypeError ? window.i18n.t("errGeneric") : error.message;
    message.classList.add("error");
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector("span").textContent = window.i18n.t("submit");
  }
});
