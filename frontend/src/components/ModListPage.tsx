import React from 'react';
import ModListEditor from './ModListEditor';

/**
 * ModList 页面入口。
 *
 * 这里曾经是一个「已临时关闭」的占位页（commit f44d03d4），但真正的关闭原因是
 * 编辑器读取路径拿到的是**加密载荷却从不解密** —— 列表永远是空的，
 * 看起来像"页面坏了"。读取改走 `/api/modlist/json`（普通 JSON、仍需登录）后，
 * 编辑器本身是完好的，因此恢复真实页面。
 */
const ModListPage: React.FC = () => {
  return <ModListEditor />;
};

export default ModListPage;
