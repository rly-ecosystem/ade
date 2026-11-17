'use strict';

async function trustProject(page) {
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

module.exports = { showInspector, openDetails, trustProject };
