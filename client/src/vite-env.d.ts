/// <reference types="vite/client" />

/**
 * 静态资源模块声明。
 * 让 `import img from '/xxx.png'` 在 TypeScript 中得到正确类型，
 * 同时交由 Vite 处理实际路径（配合 base: './' 以适配 file:// 协议）。
 */
declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}
