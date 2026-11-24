// Shows or hides the delivery address form.
function toggleDeliveryAddress(useBillingAddress) {
  const section = document.querySelector(".delivery-address");
  if (useBillingAddress) {
    section.hidden = true;
  } else {
    section.hidden = false;
  }
}

document.querySelector("#same-address").addEventListener("change", function (event) {
  toggleDeliveryAddress(event.target.checked);
});
