'use strict';

async function resizeDesktop(app, page, width, height, zoom = 1) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(320, 480);
    window.setContentSize(size.width, size.height);
    window.webContents.setZoomFactor(size.zoom);
  }, { width, height, zoom });
  // The macOS runner may clamp native windows to its 1024px display.
  await page.setViewportSize({ width, height });
  await page.waitForFunction(expected => innerWidth === expected, Math.round(width / zoom));
}

async function desktopPage(app) {
  const page = await app.firstWindow();
  await resizeDesktop(app, page, 1280, 860);
  return page;
}

async function trustProject(page) {
  await showInspector(page);
  // Trust removes its own checkbox; check() cannot verify that detached input.
  await page.getByRole('checkbox', { name: /Доверяю проекту/ }).click();
  await page.locator('.local-trust').waitFor({ state: 'hidden' });
}

async function showInspector(page) {
  const toggle = page.getByRole('button', { name: 'Ход задачи', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('complementary', { name: 'Ход задачи', exact: true }).waitFor({ state: 'visible' });
}

async function openDetails(page, selector) {
  const details = page.locator(selector);
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
}

module.exports = { desktopPage, resizeDesktop, showInspector, openDetails, trustProject };
