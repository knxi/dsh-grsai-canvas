/* 插件自我更新(「更新」按钮):问宿主现状、检查清单、下载安装、回滚上一版。
 *
 * 下载/校验/解压/替换全部由宿主半边做(浏览器跨域拿不到别人的站点、也写不了安装目录),这里只管把结果说清楚。全局零件作用域里的 `api`/`DEFAULT_UPDATE_URL`/`compareVersion` 直接用;CanvasTab 内部的状态与 ref 由调用处经 `p` 注入(调用处见 `12-canvas-tab.js`);
 * 零件里的函数闭包的是**当次渲染**的 p,所以每渲染一次就建一次(和原来一模一样)。
 */
    definePart('update-center', () => {
      /**
       * @param {object} p - 依赖包。
       * @returns {{ canUpdate, effectiveUpdateUrl, loadUpdateStatus, checkUpdate, applyUpdateNow, rollbackUpdateNow }} 这组动作。
       */
      function createUpdateCenter(p) {
        const {
          featuresRef,
          sessionRef,
          setNotice,
          setUpdateBusy,
          setUpdateInfo,
          setUpdateNote,
          setUpdateStatus,
          updateDraft,
          updateUrl,
        } = p;

        /** 宿主支不支持更新(旧宿主没有这组路由)。 */
        function canUpdate() {
          return featuresRef.current.includes('update');
        }

        /** 这次要用哪个更新源:自己填的优先,留空就用内置默认地址(装好即自动检测)。 */
        function effectiveUpdateUrl() {
          return String(updateUrl || '').trim() || DEFAULT_UPDATE_URL;
        }

        /** 问宿主「我现在是什么版本、有没有备份」——不发网络请求,打开面板就能看到。 */
        async function loadUpdateStatus() {
          if (!canUpdate()) return null;
          try {
            const data = await api('/update/status', undefined, sessionRef.current);
            setUpdateStatus(data && data.ok ? data : null);
            return data;
          } catch {
            setUpdateStatus(null);
            return null;
          }
        }

        /**
         * 检查有没有新版本。
         * @param {boolean} silent - 静默模式(启动时自动跑):失败不打扰,只在真有新版时冒个角标。
         * @returns {Promise<void>} 检查完。
         */
        async function checkUpdate(silent) {
          const url = String(silent ? effectiveUpdateUrl() : updateDraft.trim() || effectiveUpdateUrl()).trim();
          if (!url) {
            if (!silent) setUpdateNote('先在下面填「更新地址」——就是那份清单 JSON 的完整地址');
            return;
          }
          if (!canUpdate()) {
            if (!silent) setUpdateNote('宿主半边是旧版:更新要重启一次 DSH 才能用');
            return;
          }
          setUpdateBusy('check');
          if (!silent) setUpdateNote('');
          try {
            const data = await api('/update/check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            }, sessionRef.current);
            setUpdateInfo(data);
            await loadUpdateStatus();
            if (data.newer) {
              // 自动检测到新版:状态栏留一句,设置按钮也会变成「设置 ⬆x.y.z」
              setNotice(`插件有新版本 ${data.version}(当前 ${data.current})—— 设置 → ③ 插件更新`);
            }
            if (!silent) {
              // 三种情况分开说清:站点更新、本机反而更新(站点还没发布这一版)、两边一样
              const ahead = !data.newer && compareVersion(data.current, data.version) > 0;
              setUpdateNote(
                data.newer
                  ? `发现新版本 ${data.version}(当前 ${data.current})——点「立即更新」就会下载安装`
                  : ahead
                    ? `已经是最新的:本机 ${data.current} 比站点上的 ${data.version} 还新(站点还没发布这一版)`
                    : `已经是最新的(当前 ${data.current},发布的是 ${data.version})`,
              );
            }
          } catch (e) {
            if (!silent) setUpdateNote(`检查失败:${String((e && e.message) || e)}`);
            else setUpdateInfo(null);
          } finally {
            setUpdateBusy('');
          }
        }

        /** 下载并就地安装(宿主会先备份、校验 sha256、只写插件目录)。 */
        async function applyUpdateNow() {
          const url = String(updateDraft.trim() || effectiveUpdateUrl()).trim();
          if (!url) {
            setUpdateNote('先填更新地址');
            return;
          }
          setUpdateBusy('apply');
          setUpdateNote('');
          try {
            const data = await api('/update/apply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            }, sessionRef.current);
            setUpdateNote(`已更新:${data.from} → ${data.to}(${data.files} 个文件)。刷新页面即用上新客户端;宿主半边要重启 DSH 才生效。`);
            setNotice(`插件已更新到 ${data.to} —— 重启 DSH 后宿主也换新`);
            setUpdateInfo(null);
            await loadUpdateStatus();
          } catch (e) {
            setUpdateNote(`更新失败(什么都没改):${String((e && e.message) || e)}`);
          } finally {
            setUpdateBusy('');
          }
        }

        /** 回滚到上一个版本(上一次更新前自动备份的那份)。 */
        async function rollbackUpdateNow() {
          setUpdateBusy('rollback');
          setUpdateNote('');
          try {
            const data = await api('/update/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, sessionRef.current);
            setUpdateNote(`已回滚到 ${data.to}(${data.files} 个文件)。刷新页面生效,宿主同样要重启 DSH。`);
            setNotice(`插件已回滚到 ${data.to}`);
            await loadUpdateStatus();
          } catch (e) {
            setUpdateNote(`回滚失败:${String((e && e.message) || e)}`);
          } finally {
            setUpdateBusy('');
          }
        }

        return { canUpdate, effectiveUpdateUrl, loadUpdateStatus, checkUpdate, applyUpdateNow, rollbackUpdateNow };
      }

      return { createUpdateCenter };
    });
