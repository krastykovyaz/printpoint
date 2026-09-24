const form = document.querySelector("#order-form");
const fileInput = document.querySelector("#resume");
const dropzone = document.querySelector("#dropzone");
const fileName = document.querySelector("#file-name");
const copies = document.querySelector("#copies");
const message = document.querySelector("#form-message");
const submitButton = document.querySelector("#submit-button");

function showFile(file) {
  if (!file) {
    fileName.textContent = "";
    dropzone.classList.remove("has-file");
    return;
  }
  fileName.textContent = `Attached: ${file.name}`;
  dropzone.classList.add("has-file");
}

function updateCopies(amount) {
  const next = Math.min(100, Math.max(1, Number(copies.value || 1) + amount));
  copies.value = next;
}

fileInput.addEventListener("change", () => showFile(fileInput.files[0]));
document.querySelector("#decrease").addEventListener("click", () => updateCopies(-1));
document.querySelector("#increase").addEventListener("click", () => updateCopies(1));

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
});
dropzone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  showFile(file);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  message.className = "form-message";

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Sending request…";

  try {
    const response = await fetch("/api/orders", { method: "POST", body: new FormData(form) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not send your order.");

    message.textContent = `${result.message} Your order number is ${result.orderCode}.`;
    message.classList.add("success");
    form.reset();
    copies.value = 1;
    showFile(null);
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector("span").textContent = "Send print request";
  }
});
