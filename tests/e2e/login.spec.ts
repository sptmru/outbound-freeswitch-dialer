import { expect, test } from "@playwright/test";

test("renders a keyboard-usable login screen without exposing telephony controls", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Outbound calling workspace")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email");
  await expect(page.getByLabel("Password")).toHaveAttribute("autocomplete", "current-password");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("FreeSWITCH")).toHaveCount(0);

  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
});
