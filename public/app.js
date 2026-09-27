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

const MIN_ORDER = 4;
const BULK_THRESHOLD = 10;
const REVOLUT_TAG = "kovyaz";
const RATES = {
  "black-white": { standard: 0.5, bulk: 0.3 },
  color: { standard: 0.6, bulk: 0.4 }
};

function getSelectedPrintMode() {
  const checked = form.querySelector('input[name="printMode"]:checked');
  return checked ? checked.value : "black-white";
}

function calculateTotal(rawCopies, printMode) {
  const count = Math.max(MIN_ORDER, Number(rawCopies) || MIN_ORDER);
  const rates = RATES[printMode] || RATES["black-white"];
  const standardCount = Math.min(count, BULK_THRESHOLD);
  const extraCount = Math.max(0, count - BULK_THRESHOLD);
  return standardCount * rates.standard + extraCount * rates.bulk;
}

function updatePriceSummary() {
  if (!priceTotalAmount) return;
  const total = calculateTotal(copies.value, getSelectedPrintMode());
  priceTotalAmount.textContent = `€${total.toFixed(2)}`;
}

function updatePaymentPrompt() {
  if (!paymentBox) return;
  const isValidEmail = emailInput.checkValidity() && emailInput.value.trim().length > 0;
  if (isValidEmail) emailInput.classList.remove("has-error");
  paymentBox.hidden = !isValidEmail;
  if (!isValidEmail) return;

  const total = calculateTotal(copies.value, getSelectedPrintMode());
  const amount = total.toFixed(2);
  paymentAmount.textContent = `€${amount}`;
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
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not send your order.");

    message.textContent = `${result.message} Your order number is ${result.orderCode}.`;
    message.classList.add("success");
    form.reset();
    copies.value = MIN_ORDER;
    showFile(null);
    showPaymentProofFile(null);
    closePaymentProofModal();
    hasPromptedForReceipt = false;
    hasClickedPayLink = false;
    refreshOrderSummary();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector("span").textContent = window.i18n.t("submit");
  }
});
