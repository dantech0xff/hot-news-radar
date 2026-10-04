/**
 * The seeded `telegram-main` channel was created to take over from the retired
 * Cloudflare Worker, so it must not start delivering before its cutover
 * instant (`notBefore`) is saved: Resume and "Chạy ngay" stay locked in the UI
 * (and the API refuses a run) until the operator sets the instant and confirms
 * the change. The channel is never resumed here.
 */

import { SEEDED_CHANNEL } from './fixtures/constants.js';
import { MUTATION_HEADERS, browserInputValue, card, expect, test } from './fixtures/dashboard-test.js';

const CUTOVER_NOTICE = 'Cần đặt mốc cutover trước khi kênh đăng bài';

test('telegram-main cannot resume or run until its cutover instant is saved', async ({ page, request, harness }) => {
  await page.goto(`/operations?channel=${SEEDED_CHANNEL.id}`);
  const statusCard = card(page, 'Trạng thái kênh');
  await expect(statusCard).toContainText(SEEDED_CHANNEL.name);
  await expect(statusCard.getByText(CUTOVER_NOTICE)).toBeVisible();
  await expect(statusCard.getByText('Tạm dừng', { exact: true })).toBeVisible();
  const resume = statusCard.getByRole('button', { name: 'Resume', exact: true });
  const runNow = statusCard.getByRole('button', { name: 'Chạy ngay' });
  await expect(resume).toBeDisabled();
  await expect(resume).toHaveAttribute('title', 'Cần đặt mốc cutover (notBefore) trước khi resume');
  await expect(runNow).toBeDisabled();
  await expect(runNow).toHaveAttribute('title', 'Cần đặt mốc cutover (notBefore) trước khi chạy');

  // The server enforces the same rule, whatever the UI shows.
  const refused = await request.post(`/api/channels/${SEEDED_CHANNEL.id}/run`, { headers: MUTATION_HEADERS, data: {} });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: 'cutover_required' });

  await statusCard.getByRole('link', { name: 'Đặt mốc cutover' }).click();
  await expect(page).toHaveURL(new RegExp(`/channels/${SEEDED_CHANNEL.id}/edit#section-cutover$`));
  const form = page.getByRole('form', { name: 'Cấu hình kênh' });
  await form.getByLabel('Không đăng bài trước (giờ trình duyệt)', { exact: true }).fill(browserInputValue(harness.fixture.notBefore));
  const save = form.getByRole('button', { name: 'Lưu thay đổi' });

  // Changing the cutover instant needs an explicit confirmation.
  await save.click();
  await expect(form.getByRole('alert')).toContainText('Hãy xác nhận thay đổi mốc cutover.');
  const unconfirmed = await (await request.get(`/api/channels/${SEEDED_CHANNEL.id}`)).json();
  expect(unconfirmed.notBefore).toBeNull();

  await form.getByRole('checkbox', { name: /^Tôi hiểu tác động và muốn thay đổi mốc cutover/ }).check();
  await save.click();
  await expect(page.getByText('Đã lưu cấu hình kênh')).toBeVisible();
  const saved = await (await request.get(`/api/channels/${SEEDED_CHANNEL.id}`)).json();
  expect(saved).toMatchObject({ notBefore: harness.fixture.notBefore, cutoverRequired: true, version: unconfirmed.version + 1 });

  await page.goto(`/operations?channel=${SEEDED_CHANNEL.id}`);
  await expect(resume).toBeEnabled();
  await expect(statusCard.getByText(CUTOVER_NOTICE)).toHaveCount(0);
  // Still paused: running waits for an explicit Resume, which this test never does.
  await expect(runNow).toBeDisabled();
  await expect(runNow).toHaveAttribute('title', 'Kênh đang tạm dừng — hãy Resume trước');

  const status = await (await request.get(`/api/channels/${SEEDED_CHANNEL.id}/status`)).json();
  expect(status.paused).toBe(true);
  const runs = await (await request.get(`/api/channels/${SEEDED_CHANNEL.id}/runs`)).json();
  expect(runs.runs).toEqual([]);
});
