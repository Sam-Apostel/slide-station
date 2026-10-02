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

// Before / after: the range input (invisible, over the photo) moves the divider; the thumbnails
// below swap the example. Without JavaScript it shows a fixed half-and-half split.
const compare = document.querySelector("[data-compare]");
if (compare) {
  const range = compare.querySelector("input");
  const set = (v) => compare.style.setProperty("--pos", `${v}%`);
  range.addEventListener("input", () => set(range.value));
  const [after, before] = compare.querySelectorAll("img");
  for (const button of document.querySelectorAll("[data-slide]")) {
    button.addEventListener("click", () => {
      const { slide, caption } = button.dataset;
      after.src = `/assets/img/${slide}-after.webp`;
      after.alt = `${caption}, restored by Slide Station`;
      before.src = `/assets/img/${slide}-before.webp`;
      before.alt = `${caption}, the faded scan`;
      for (const b of document.querySelectorAll("[data-slide]")) b.setAttribute("aria-pressed", String(b === button));
      range.value = 50;
      set(50);
    });
  }
}
