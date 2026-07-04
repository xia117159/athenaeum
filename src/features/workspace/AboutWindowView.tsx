import "./workspace.about.css";

const appIconUrl = "/128x128.png";
const REPO_URL = "https://github.com/xia117159/athenaeum";

export const ABOUT_APP_INFO = {
  name: "Athenaeum",
  version: "0.0.1",
  description: "Windows 文件管理器桌面应用",
  copyright: "Copyright (c) 2026 Cheng",
  license: "Apache License 2.0",
  repository: REPO_URL
};

export function AboutWindowView() {
  return (
    <section className="about-window" aria-labelledby="about-window-title">
      <header className="about-window__identity">
        <img className="about-window__icon" src={appIconUrl} alt={`${ABOUT_APP_INFO.name} 图标`} width="64" height="64" />
        <div>
          <h1 id="about-window-title">{ABOUT_APP_INFO.name}</h1>
          <p>版本 {ABOUT_APP_INFO.version}</p>
          <p>{ABOUT_APP_INFO.description}</p>
        </div>
      </header>

      <main className="about-window__body">
        <section className="about-window__section" aria-label="产品信息">
          <div className="about-window__row">
            <span>发布者</span>
            <strong>Cheng</strong>
          </div>
          <div className="about-window__row">
            <span>版权</span>
            <strong>{ABOUT_APP_INFO.copyright}</strong>
          </div>
        </section>

        <section className="about-window__section" aria-label="开源信息">
          <h2>开源信息</h2>
          <div className="about-window__row">
            <span>许可证</span>
            <strong>{ABOUT_APP_INFO.license}</strong>
          </div>
          <div className="about-window__row">
            <span>项目</span>
            <a className="about-window__link" href={REPO_URL} target="_blank" rel="noopener noreferrer">{ABOUT_APP_INFO.repository}</a>
          </div>
          <div className="about-window__stack">
            <span>Tauri v2</span>
            <span>Rust</span>
            <span>React</span>
            <span>TypeScript</span>
          </div>
        </section>
      </main>
    </section>
  );
}
