/* ── 零件机(运行时的最小模块系统)───────────────────────────────────────────
 *
 * 为什么要有它:`dsh.client` 只认一个 `exports["./client"]` bundle,浏览器只加载
 * `lib/client.js` 这一个文件 —— 所以"分模块"只能靠构建期把 `lib/parts/*.js` 拼进来。
 * 拼进来以后,各零件若都用同一个作用域,就成了"换行的单文件",既不能显式声明依赖,
 * 也挡不住重名。这里给它们一层薄薄的隔离:
 *
 *   definePart('marks', (rt) => { const { clamp } = rt.utils; … return { renderMarks }; });
 *
 * 取用是**惰性**的:第一次访问 `rt.marks` 才构造 marks 零件,构造结果被缓存,
 * 所以零件之间可以随意引用(只要不成环 —— 成环会在构造时立刻抛错,不会静默死循环)。
 *
 * 注意:本文件(以及所有零件)整体嵌在 `__ModuleLoader__.load` 的 factory 里,
 * 所以顶层缩进是 4 空格 —— 构建脚本是**原样拼接**,不重排缩进。
 */
    const PART_FACTORIES = new Map();
    const PART_EXPORTS = new Map();
    const PART_STACK = [];

    /**
     * 注册一个零件。
     * @param name - 零件名(全局唯一,零件之间就用它互相取用)。
     * @param factory - `(rt) => 导出对象`;rt 是依赖包,`rt.foo` 就是零件 foo 的导出。
     */
    function definePart(name, factory) {
      if (PART_FACTORIES.has(name)) throw new Error(`[grsai-canvas] 零件重名:${name}`);
      PART_FACTORIES.set(name, factory);
    }

    /**
     * 构造(或取用已构造的)零件。
     * @param name - 零件名。
     * @returns 该零件的导出对象。
     */
    function part(name) {
      if (PART_EXPORTS.has(name)) return PART_EXPORTS.get(name);
      const factory = PART_FACTORIES.get(name);
      if (!factory) throw new Error(`[grsai-canvas] 没有这个零件:${name}(先 definePart 再取用)`);
      if (PART_STACK.includes(name)) throw new Error(`[grsai-canvas] 零件互相依赖成环:${PART_STACK.concat(name).join(' → ')}`);
      PART_STACK.push(name);
      let made;
      try {
        made = factory(rt) || {};
      } finally {
        PART_STACK.pop();
      }
      PART_EXPORTS.set(name, made);
      return made;
    }

    /** 零件的依赖包:`rt.foo` = 零件 foo 的导出(惰性构造)。 */
    const rt = new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key !== 'string') return undefined;
          return part(key);
        },
      },
    );

    /**
     * 给「界面零件」的依赖包加一道守卫。
     *
     * 界面零件(工具栏 / 生成区块 / 设置面板…)靠调用处显式传依赖,好处是接口一眼可见;
     * 坏处是漏传一个就是静默的 `undefined` —— 界面上表现为某个按钮点了没反应,
     * 排起来很费劲。包一层 Proxy 之后,漏传会在**用到的那一刻**抛出带零件名的错。
     * @param name - 零件名(报错信息里用)。
     * @param bag - 依赖对象(键名与零件内部解构的名字一致)。
     * @returns 包好的依赖包。
     */
    function deps(name, bag) {
      return new Proxy(bag, {
        get(target, key) {
          if (typeof key !== 'string' || key in target) return target[key];
          throw new Error(`[grsai-canvas] 零件 ${name} 缺依赖:${key}`);
        },
        has() {
          return true;
        },
      });
    }

    const React = require('react');
    const h = React.createElement;
    const { useState, useRef, useEffect, useCallback } = React;
