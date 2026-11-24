document.addEventListener("DOMContentLoaded", function () {
  var form = document.getElementById("login");
  fetch("https://api.shop.example/session", { credentials: "include" });
  form.dataset.ready = "1";
});