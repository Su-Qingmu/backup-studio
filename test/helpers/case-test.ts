import { test as nodeTest, type TestContext, type TestOptions } from 'node:test';
import { runCase } from './test-temp';

/**
 * node:test 的用例级生命周期适配。
 *
 * node:test 自带的 t.after() 钩子**无条件执行**，所以
 * t.after(() => fs.rm(root, { recursive: true, force: true }))
 * 会在断言失败后把现场删掉——失败用例就再也查不出原因了。
 *
 * 这里用 runCase 包一层：成功删目录，失败保留目录并把路径写进错误信息。
 * 用例体拿到的临时目录一律用 caseTempDir() 创建，它会落在当前用例目录下。
 *
 * 参数顺序刻意与 node:test 保持一致（name、options、fn），
 * 这样原有带 { skip } 选项的用例只需改最前面的函数名。
 */
export function caseTest(
  suite: string,
  name: string,
  options: TestOptions | undefined,
  fn: (t: TestContext) => Promise<void> | void,
): void {
  nodeTest(name, options ?? {}, async (t: TestContext) => {
    await runCase(suite, name, async () => {
      await fn(t);
    });
  });
}
