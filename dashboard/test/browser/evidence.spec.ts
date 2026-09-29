import {test, expect} from "@playwright/test";

test("old dashboard routes are removed", async ({request}) => {
  for (const path of ["/evidence", "/evidence?run=maxwell-e2e-positive", "/evidence.html", "/evidence/"]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test("supporting files stay inert and private files stay inaccessible", async ({page, request}) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/basics?run=maxwell-e2e-positive");
  await expect(page.locator('.narrative[data-ready="true"]')).toBeVisible();
  await page.getByText("Schema and row comparison evidence", {exact: true}).click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", {name: "source-rows.json", exact: true}).click();
  const popup = await popupPromise;
  await expect(popup.locator("body")).toContainText("<script>window.evidenceExecuted=true</script>");
  expect(await popup.evaluate(() => (window as unknown as {evidenceExecuted?: boolean}).evidenceExecuted)).toBeUndefined();
  for (const path of ["maxwell-e2e-positive/container-inspect.json", "../../package.json"]) {
    expect((await request.get(`/api/evidence?path=${encodeURIComponent(path)}`)).status()).toBe(404);
  }
  expect(errors).toEqual([]);
});
