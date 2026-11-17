import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const system of ["macos", "windows-11", "debian"]) {
  const calls = [];
  const native = system !== "debian";
  let componentStatus = "update_required";
  const fixture = await createWorkbench({ beforeNavigate: async (page, state) => {
    state.account.guest_system = state.status.guest_system = system;
    state.status.vm_running = state.status.ready = true;
    await page.route("**/api/environment/versions", route => route.fulfill({ json: {
      vm_running: true, tools_update_allowed: true,
      components: { status: componentStatus, update_required: componentStatus === "update_required" },
      controller: { version: "fixture-controller" },
      tools: { claude: { current: "2.1.300", required: "2.1.311" }, node: { current: "v24.22.2", required: "24.22.2" } },
      maintenance: native ? { native: true, guest_system: system, requires_closed_terminals: true } : undefined,
    } }));
    for (const operation of ["update", "tools"]) {
      await page.route(`**/api/environment/${operation}`, route => {
        calls.push(operation);
        return route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: "请先保存工作，结束正在运行的终端和 Claude Code 轮次，再重试更新。" });
      });
    }
  } });
  const { page, browser, state, errors } = fixture;
  try {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: "环境与恢复", exact: true }).click();
    const panel = page.getByRole("region", { name: "环境版本", exact: true });
    await panel.getByText("2.1.300", { exact: true }).waitFor();
    await panel.getByText("2.1.311", { exact: true }).waitFor();
    for (const operation of ["组件", "工具"]) {
      await panel.getByRole("button", { name: `更新环境${operation}`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `更新环境${operation}？`, exact: true });
      const text = await dialog.innerText();
      if (native) {
        assert.ok(text.includes("结束正在运行的终端和 Claude Code 轮次"));
        assert.ok(text.includes("聊天历史、项目文件与登录资料会保留"));
        assert.equal(text.includes("验证已绑定客机的管理员账户"), system === "windows-11");
      } else {
        assert.ok(text.includes("工作台终端、项目文件和登录状态会保留"));
      }
      await dialog.getByRole("button", { name: `更新${operation}`, exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: "结束正在运行的终端" }).waitFor();
    }
    assert.deepEqual(calls, ["update", "tools"]);

    if (native) {
      componentStatus = "unknown";
      await panel.getByRole("button", { name: "刷新版本", exact: true }).click();
      await panel.getByText("暂时无法确认", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "更新环境组件", exact: true }).isEnabled(), true,
        "an old native guest without a readable receipt must retain manual component maintenance");
    }

    // A confirmed mismatch must lead to component maintenance from both
    // recovery surfaces, even when no browser or network gate is ready.
    state.status.ready = false;
    state.status.environment_update_required = true;
    state.status.environment_update_error = "请在设置的“版本与组件”中更新环境组件；仅重启不会安装缺失文件。";
    state.status.safety = {};
    await page.reload();
    const mutations = () => state.requests.filter(request => request.method === "POST" &&
      ["/start", "/safety/check", "/environment/update", "/environment/tools"].includes(request.path)).length;
    const before = mutations();
    await page.getByRole("button", { name: "更新环境组件", exact: true }).click();
    await page.getByRole("region", { name: "环境版本", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "重启环境并加载检测组件？", exact: true }).count(), 0);
    assert.equal(mutations(), before);
    await page.keyboard.press("Escape");
    await page.getByTitle("网络与隔离检查", { exact: true }).click();
    const safety = page.getByRole("dialog", { name: "网络与隔离检查", exact: true });
    await safety.getByRole("button", { name: "更新环境组件", exact: true }).click();
    await page.getByRole("region", { name: "环境版本", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "重启环境并加载检测组件？", exact: true }).count(), 0);
    assert.equal(mutations(), before);
    assert.deepEqual(calls, ["update", "tools"]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ system, passed: true, calls }));
  } finally {
    await browser.close();
  }
}
