import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * 首屏就绪后收尾：撤掉启动骨架，再通知主进程把窗口亮出来（issue #10）。
 *
 * 主进程不在 ready-to-show 时显示窗口：那早于 React 首帧，显示出来是一块
 * 只有 backgroundColor 的空壳（深色主题下近乎纯黑）。等首屏真正画出来再显示，
 * 用户看到的第一帧就是界面；等待期间 index.html 的启动骨架负责给出反馈。
 *
 * 用 requestAnimationFrame 而非直接调用：createRoot().render() 是异步的，
 * 此刻 DOM 还没更新，通知早了主进程显示出来仍是骨架而不是界面。
 * 套两层是为了跨过一次绘制：第二层回调运行时，React 的首帧已经画完。
 */
const api = (window as unknown as { backupAPI?: { notifyBootReady?: () => void } }).backupAPI;
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    /*
     * 撤掉启动骨架：必须无条件执行，不能挂在「主进程桥接存在」的判断里。
     *
     * 骨架是脱离文档流的 fixed 浮层（见 index.html 里的说明），它的消失只能
     * 靠这一步——React 18 的 createRoot 首次挂载并不会清空容器，骨架若留在
     * 文档里就会一直盖在界面上。若这一步因桥接缺失被跳过，界面永远出不来。
     */
    document.getElementById('boot')?.remove();
    // 再通知主进程：浏览器开发兜底没有主进程，此时什么都不做即可。
    api?.notifyBootReady?.();
  });
});
