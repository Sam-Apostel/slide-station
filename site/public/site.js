// Joins the waitlist without leaving the page; without JavaScript the form posts and redirects.
const form = document.querySelector("form.waitlist");
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  const error = form.querySelector(".error");
  button.disabled = true;
  error.textContent = "";
  try {
    const res = await fetch(form.action, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(form)),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    form.querySelector(".joined").innerHTML =
      "<strong>You're on the list.</strong> Thanks! The invite will come from TestFlight.";
    form.dataset.state = "joined";
  } catch (err) {
    error.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    button.disabled = false;
  }
});
