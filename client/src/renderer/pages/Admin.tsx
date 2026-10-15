import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../store/authStore';
import { parseRoomImages } from './RoomList';
import './Admin.css';

interface AdminUser {
  id: string;
  username: string;
  nickname: string;
  email: string;
  isAdmin: boolean;
  banned: boolean;
  banReason?: string | null;
  bannedAt?: string | null;
  lastIp?: string | null;
  maxRoomsPerIp: number;
  createdAt: string;
  _count?: { rooms: number };
}

interface BannedIp {
  id: string;
  ip: string;
  reason?: string | null;
  createdAt: string;
}

interface AdminRoom {
  id: string;
  name: string;
  description?: string | null;
  images?: string | null;
  status: string;
  hasPassword?: boolean;
  maxViewers: number;
  currentMovie?: string | null;
  createdAt: string;
  updatedAt: string;
  host: { id: string; username: string; nickname: string };
  _count?: { members: number };
}

/** 【需求4A】当前生效的广播 */
interface AdminBroadcast {
  id: string;
  content: string;
  color: string;
  speed: number;
  active: boolean;
  createdAt: string;
}

/** 【需求4B】公告（含已读人数） */
interface AdminAnnouncement {
  id: string;
  title?: string | null;
  content: string;
  createdAt: string;
  _count?: { reads: number };
}

/** 【公共房间需求】后台「公共房间」列表项 */
interface AdminPublicRoom {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  memberCount: number;
  owner: string;
  /** none=未设密码（通道关闭）/ ready=密码待用 / screening=放映中 */
  channelState: 'none' | 'ready' | 'screening';
  screeningUser: string | null;
  screeningGraceUntil: string | null;
  screeningUpdatedAt: string | null;
}

/** 【需求3】后台功能项。以后所有新增的管理员功能都应加入这里，统一放进可折叠面板。 */
type AdminTab = 'users' | 'ips' | 'rooms' | 'publicRooms' | 'broadcast';

const ADMIN_TAB_LABELS: Record<AdminTab, string> = {
  users: '用户管理',
  ips: '封禁 IP',
  rooms: '房间列表',
  publicRooms: '公共房间',
  broadcast: '广播/公告'
};

/** 广播速度档与弹幕同口径（1~5 档），此处仅用于在后台回显「大概几秒滚完」 */
const BROADCAST_COLOR_PRESETS = [
  { label: '白', value: '#ffffff' },
  { label: '红', value: '#ff4d4f' },
  { label: '黄', value: '#fadb14' },
  { label: '蓝', value: '#40a9ff' },
  { label: '绿', value: '#52c41a' }
];

function speedToDuration(level: number): string {
  const lv = Math.max(1, Math.min(5, level));
  const eff = 1 + (lv - 1) * 0.375; // 与客户端 speedToScrollDuration 完全一致
  return (8 / eff).toFixed(1);
}

export default function Admin() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [bannedIps, setBannedIps] = useState<BannedIp[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  // 【公共房间需求】公共房间列表与其放映密码输入
  const [publicRooms, setPublicRooms] = useState<AdminPublicRoom[]>([]);
  const [screeningInputs, setScreeningInputs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // 消息带类型：原先所有消息（含「封禁失败」）都用 success 绿色样式渲染，
  // 管理员会看到一片绿色的失败提示，误判操作已生效。
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<AdminTab>('users');
  // 【需求3】后台功能面板默认折叠；「以后所有新增管理员功能统统折叠」为长期规范
  const [toolsOpen, setToolsOpen] = useState(false);

  // 【需求4A/4B】广播与公告
  const [broadcast, setBroadcast] = useState<AdminBroadcast | null>(null);
  const [announcementList, setAnnouncementList] = useState<AdminAnnouncement[]>([]);
  const [publishMode, setPublishMode] = useState<'broadcast' | 'announcement'>('broadcast');
  const [broadcastContent, setBroadcastContent] = useState('');
  const [broadcastColor, setBroadcastColor] = useState('#ff4d4f');
  const [broadcastSpeed, setBroadcastSpeed] = useState(3);
  const [announcementTitle, setAnnouncementTitle] = useState('');
  const [announcementContent, setAnnouncementContent] = useState('');
  const [publishing, setPublishing] = useState(false);

  // 请求序号：只采纳最新请求结果，防止旧响应覆盖新状态
  const reqIdRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      // 【需求4A/4B】广播/公告面板：拉取当前广播与公告列表（含已读人数）
      if (tab === 'broadcast') {
        const [{ data: bData }, { data: aData }] = await Promise.all([
          api.get('/admin/broadcast'),
          api.get('/admin/announcements')
        ]);
        if (reqId !== reqIdRef.current) return;
        setBroadcast(bData.broadcast || null);
        setAnnouncementList(aData.announcements || []);
        return;
      }

      // 【公共房间需求】公共房间列表（含放映通道状态）
      if (tab === 'publicRooms') {
        const { data } = await api.get('/admin/public-rooms');
        if (reqId !== reqIdRef.current) return;
        setPublicRooms(data.rooms || []);
        return;
      }

      const params = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      // 搜索时无需拉取与搜索无关的封禁 IP 列表（原实现每次按键都会多打一个请求）
      if (tab === 'rooms') {
        const { data: roomsData } = await api.get(`/admin/rooms${params}`);
        if (reqId !== reqIdRef.current) return;
        setRooms(roomsData.rooms || []);
      } else if (params) {        const { data: usersData } = await api.get(`/admin/users${params}`);
        if (reqId !== reqIdRef.current) return;
        setUsers(usersData.users || []);
      } else {
        const [{ data: usersData }, { data: ipsData }] = await Promise.all([
          api.get('/admin/users'),
          api.get('/admin/banned-ips')
        ]);
        if (reqId !== reqIdRef.current) return;
        setUsers(usersData.users || []);
        setBannedIps(ipsData.bannedIps || []);
      }
    } catch (error: any) {
      if (reqId !== reqIdRef.current) return;
      setMessage({ type: 'error', text: error.response?.data?.error || '获取数据失败' });
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [search, tab]);

  // 防抖：原先每敲一个字符触发 2 个请求
  useEffect(() => {
    const timer = setTimeout(fetchAll, 400);
    return () => clearTimeout(timer);
  }, [fetchAll]);

  const banUser = async (user: AdminUser) => {
    const reason = prompt(`请输入封禁「${user.nickname || user.username}」的原因（必填）：`, '管理员手动封禁');
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setMessage({ type: 'error', text: '封禁原因不能为空' });
      return;
    }
    if (trimmed.length > 200) {
      setMessage({ type: 'error', text: '封禁原因不能超过 200 字' });
      return;
    }
    try {
      await api.post(`/admin/users/${user.id}/ban`, { reason: trimmed });
      setMessage({ type: 'success', text: `已封禁 ${user.username}` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '封禁失败' });
    }
  };

  const unbanUser = async (user: AdminUser) => {
    if (!confirm(`确定解除对「${user.nickname || user.username}」的封禁吗？`)) return;
    try {
      await api.post(`/admin/users/${user.id}/unban`);
      setMessage({ type: 'success', text: `已解除封禁 ${user.username}` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '解除封禁失败' });
    }
  };

  const forceLogoutUser = async (user: AdminUser) => {
    if (!confirm(
      `⚠️ 确定强制注销「${user.nickname || user.username}」吗？\n\n` +
      `该账号的全部信息（资料、房间、成员记录等）将被永久抹除，此操作不可恢复。\n` +
      `但该用户仍可使用相同的邮箱 / 用户名重新注册。`
    )) return;
    try {
      await api.post(`/admin/users/${user.id}/force-logout`);
      setMessage({ type: 'success', text: `已强制注销 ${user.username}，其全部信息已抹除` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '强制注销失败' });
    }
  };

  // 【需求3】调整某用户「每个 IP 同时可开设的房间数」（0–20）。
  // 取 0 即禁止该用户开房，但**不影响其加入他人房间**。
  const changeMaxRooms = async (user: AdminUser) => {
    const input = prompt(
      `请输入「${user.nickname || user.username}」每个 IP 可同时开设的房间数（0 – 20）：\n\n` +
      `0 = 禁止开设房间（仍可正常加入他人的房间）`,
      String(user.maxRoomsPerIp)
    );
    if (input === null) return;
    const trimmed = input.trim();
    const n = Number(trimmed);
    if (!trimmed || !Number.isInteger(n) || n < 0 || n > 20) {
      setMessage({ type: 'error', text: '开设数量必须是 0 到 20 之间的整数' });
      return;
    }
    try {
      const { data } = await api.post(`/admin/users/${user.id}/max-rooms`, { value: n });
      setMessage({ type: 'success', text: data.message || `已将该用户的开设数量设为 ${n}` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '设置开设数量失败' });
    }
  };

  // 【需求2】解散房间：彻底删除房间及其全部成员记录，房间内在线用户会被立即请出
  const dissolveRoom = async (room: AdminRoom) => {
    if (!confirm(
      `⚠️ 确定解散房间「${room.name}」吗？\n\n` +
      `房间及其全部成员记录将被彻底删除，房间内的用户会被立即请出。\n` +
      `此操作不可恢复。`
    )) return;
    try {
      const { data } = await api.post(`/admin/rooms/${room.id}/dissolve`);
      setMessage({ type: 'success', text: data.message || `已解散房间「${room.name}」` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '解散房间失败' });
    }
  };

  // ===== 【公共房间需求】后台「公共房间」操作 =====

  /** 解散公共房间（与普通房间解散一致：彻底删除） */
  const dissolvePublicRoom = async (room: AdminPublicRoom) => {
    if (!confirm(
      `⚠️ 确定解散公共房间「${room.name}」吗？\n\n` +
      `房间及其全部成员记录将被彻底删除，房间内的用户会被立即请出。\n` +
      `公共房间不会自动消失，这是唯一的删除方式。此操作不可恢复。`
    )) return;
    try {
      const { data } = await api.post(`/admin/rooms/${room.id}/dissolve`);
      setMessage({ type: 'success', text: data.message || `已解散公共房间「${room.name}」` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '解散公共房间失败' });
    }
  };

  /**
   * 设置/重置放映密码。
   * 传空值即清空 —— 清空后放映通道对所有人关闭（管理员仍可免密进入）。
   */
  const setScreeningPassword = async (room: AdminPublicRoom, password: string) => {
    try {
      const { data } = await api.post(`/admin/public-rooms/${room.id}/screening-password`, {
        password: password.trim() ? password.trim() : null
      });
      setMessage({ type: 'success', text: data.message || '已更新放映密码' });
      setScreeningInputs(prev => ({ ...prev, [room.id]: '' }));
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '设置放映密码失败' });
    }
  };

  const unbanIp = async (ip: BannedIp) => {
    if (!confirm(`确定解除 IP ${ip.ip} 的封禁吗？`)) return;
    try {
      await api.delete(`/admin/banned-ips/${ip.id}`);
      setMessage({ type: 'success', text: `已解除 IP ${ip.ip} 的封禁` });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '操作失败' });
    }
  };

  // 【需求3】切换后台功能：切换后收起折叠面板。
  // 只有「用户管理」使用搜索框，切到其它功能时清空搜索词 —— 否则残留的搜索词
  // 会让 fetchAll 走错分支，出现「切过去列表没刷新 / 只拉到用户列表」的情况。
  const selectTab = (next: AdminTab) => {
    setTab(next);
    setToolsOpen(false);
    if (next !== 'users') setSearch('');
  };

  // 【需求4A】发布广播：循环滚动弹幕，仅房间页可见，永久有效直到手动停播
  const publishBroadcast = async () => {
    const content = broadcastContent.trim();
    if (!content) {
      setMessage({ type: 'error', text: '广播内容不能为空' });
      return;
    }
    setPublishing(true);
    try {
      const { data } = await api.post('/admin/broadcast', {
        content,
        color: broadcastColor,
        speed: broadcastSpeed
      });
      setMessage({ type: 'success', text: data.message || '广播已发布' });
      setBroadcastContent('');
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '发布广播失败' });
    } finally {
      setPublishing(false);
    }
  };

  // 【需求4A】停播广播：所有房间页的广播条立即消失
  const stopBroadcast = async () => {
    if (!confirm('确定停播当前广播吗？停播后所有房间页的广播条会立即消失。')) return;
    try {
      const { data } = await api.post('/admin/broadcast/stop');
      setMessage({ type: 'success', text: data.message || '广播已停播' });
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '停播广播失败' });
    }
  };

  // 【需求4B】发布公告：用户下次访问首屏弹窗，每人对同一条只显示一次
  const publishAnnouncement = async () => {
    const content = announcementContent.trim();
    if (!content) {
      setMessage({ type: 'error', text: '公告内容不能为空' });
      return;
    }
    setPublishing(true);
    try {
      const { data } = await api.post('/admin/announcements', {
        title: announcementTitle.trim(),
        content
      });
      setMessage({ type: 'success', text: data.message || '公告已发布' });
      setAnnouncementTitle('');
      setAnnouncementContent('');
      fetchAll();
    } catch (error: any) {
      setMessage({ type: 'error', text: error.response?.data?.error || '发布公告失败' });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="admin-page fade-in">
      <h1>🛡️ 管理员后台</h1>

      {/* 【需求3】后台功能折叠面板：默认折叠，点标题展开/收起。
          以后所有新增的管理员功能都加入这里（长期规范）。 */}
      <div className="admin-toolbar">
        <div className="admin-tools">
          <button
            className="admin-tools-toggle"
            onClick={() => setToolsOpen(o => !o)}
            aria-expanded={toolsOpen}
            aria-controls="admin-tools-panel"
          >
            <span className="admin-tools-title">🧰 后台功能</span>
            {/* 折叠状态下仍显示当前功能名，避免用户必须展开才能确认自己在看哪一项 */}
            <span className="admin-tools-current">当前：{ADMIN_TAB_LABELS[tab]}</span>
            <span className={`admin-tools-chev ${toolsOpen ? 'open' : ''}`}>▾</span>
          </button>

          {toolsOpen && (
            <div className="filter-bar admin-tools-panel" id="admin-tools-panel">
              <button className={`filter-btn ${tab === 'users' ? 'active' : ''}`} onClick={() => selectTab('users')}>
                👥 用户管理 ({users.length})
              </button>
              <button className={`filter-btn ${tab === 'ips' ? 'active' : ''}`} onClick={() => selectTab('ips')}>
                🚫 封禁 IP ({bannedIps.length})
              </button>
              <button className={`filter-btn ${tab === 'rooms' ? 'active' : ''}`} onClick={() => selectTab('rooms')}>
                🏠 房间列表 ({rooms.length})
              </button>
              <button className={`filter-btn ${tab === 'publicRooms' ? 'active' : ''}`} onClick={() => selectTab('publicRooms')}>
                🏛️ 公共房间 ({publicRooms.length})
              </button>
              <button className={`filter-btn ${tab === 'broadcast' ? 'active' : ''}`} onClick={() => selectTab('broadcast')}>
                📢 广播/公告
              </button>
            </div>
          )}
        </div>

        {tab === 'users' && (
          <input
            type="text"
            className="input admin-search"
            placeholder="🔍 搜索用户名 / 昵称 / 邮箱"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {tab === 'rooms' && (
          <input
            type="text"
            className="input admin-search"
            placeholder="🔍 搜索房间名 / 电影名 / 房主"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      {loading ? (
        <div className="loading">加载中...</div>
      ) : tab === 'broadcast' ? (
        /* 【需求4A/4B】广播 / 公告 */
        <div className="admin-broadcast-panel">
          <div className="publish-mode-bar">
            <button
              className={`filter-btn ${publishMode === 'broadcast' ? 'active' : ''}`}
              onClick={() => setPublishMode('broadcast')}
            >
              📢 发布广播
            </button>
            <button
              className={`filter-btn ${publishMode === 'announcement' ? 'active' : ''}`}
              onClick={() => setPublishMode('announcement')}
            >
              📣 发布公告
            </button>
          </div>

          {publishMode === 'broadcast' ? (
            <div className="admin-form card">
              <h3>📢 发布广播</h3>
              <p className="admin-form-hint">
                广播会以<b>循环滚动文字</b>的形式出现在每个观影房间页的顶部。
                发布后立即对所有房间生效，永久滚动，直到你手动停播。
              </p>

              <label className="label">广播内容（最多 200 字）</label>
              <textarea
                className="input admin-textarea"
                rows={3}
                maxLength={200}
                value={broadcastContent}
                onChange={(e) => setBroadcastContent(e.target.value)}
                placeholder="例如：今晚 22:00 例行维护，预计 10 分钟，敬请谅解。"
              />

              <label className="label">文字颜色</label>
              <div className="color-picker-row">
                {BROADCAST_COLOR_PRESETS.map(c => (
                  <button
                    key={c.value}
                    type="button"
                    className={`color-swatch ${broadcastColor.toLowerCase() === c.value ? 'active' : ''}`}
                    style={{ backgroundColor: c.value }}
                    title={c.label}
                    aria-label={`颜色 ${c.label}`}
                    onClick={() => setBroadcastColor(c.value)}
                  />
                ))}
                <input
                  type="color"
                  className="color-input"
                  value={broadcastColor}
                  onChange={(e) => setBroadcastColor(e.target.value)}
                  title="自定义颜色"
                />
                <span className="color-value">{broadcastColor}</span>
              </div>

              <label className="label">
                快慢（与视频弹幕同口径）：第 {broadcastSpeed} 档 · 约 {speedToDuration(broadcastSpeed)} 秒滚完一轮
              </label>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={broadcastSpeed}
                onChange={(e) => setBroadcastSpeed(Number(e.target.value))}
                className="speed-range"
              />

              <div className="admin-form-actions">
                <button className="btn btn-primary" disabled={publishing} onClick={publishBroadcast}>
                  {publishing ? '发布中...' : '发布广播'}
                </button>
                {broadcast && (
                  <button className="btn btn-danger" onClick={stopBroadcast}>
                    ⏹ 停播当前广播
                  </button>
                )}
              </div>

              <div className="current-broadcast">
                {broadcast ? (
                  <>
                    <div className="current-broadcast-title">当前正在播放的广播</div>
                    <div className="current-broadcast-text" style={{ color: broadcast.color }}>
                      {broadcast.content}
                    </div>
                    <div className="current-broadcast-meta">
                      发布：{new Date(broadcast.createdAt).toLocaleString('zh-CN')}
                    </div>
                  </>
                ) : (
                  <div className="current-broadcast-empty">当前没有正在播放的广播</div>
                )}
              </div>
            </div>
          ) : (
            <div className="admin-form card">
              <h3>📣 发布公告</h3>
              <p className="admin-form-hint">
                公告会以<b>弹窗</b>形式出现在用户首屏，每名登录用户对同一条公告只看到一次。
                若用户本次访问已弹出「打赏弹窗」，公告会顺延到下次访问再弹。
              </p>

              <label className="label">公告标题（可选，最多 100 字）</label>
              <input
                type="text"
                className="input"
                maxLength={100}
                value={announcementTitle}
                onChange={(e) => setAnnouncementTitle(e.target.value)}
                placeholder="例如：v1.2 更新公告"
              />

              <label className="label">公告内容（最多 2000 字）</label>
              <textarea
                className="input admin-textarea"
                rows={6}
                maxLength={2000}
                value={announcementContent}
                onChange={(e) => setAnnouncementContent(e.target.value)}
                placeholder="例如：本次更新修复了部分设备无法播放 HLS 直链的问题，并新增了管理员广播功能。"
              />

              <div className="admin-form-actions">
                <button className="btn btn-primary" disabled={publishing} onClick={publishAnnouncement}>
                  {publishing ? '发布中...' : '发布公告'}
                </button>
              </div>

              <div className="announcement-history">
                <div className="announcement-history-title">
                  历史公告（共 {announcementList.length} 条）
                </div>
                {announcementList.length === 0 ? (
                  <div className="current-broadcast-empty">还没有发布过公告</div>
                ) : (
                  announcementList.map(a => (
                    <div key={a.id} className="announcement-history-item">
                      <div className="announcement-history-head">
                        <span className="announcement-history-name">{a.title || '（无标题）'}</span>
                        <span className="announcement-history-meta">
                          已读 {a._count?.reads || 0} 人 · {new Date(a.createdAt).toLocaleString('zh-CN')}
                        </span>
                      </div>
                      <div className="announcement-history-content">{a.content}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      ) : tab === 'rooms' ? (
        <div className="admin-room-list card">
          {rooms.length === 0 ? (
            <div className="loading">{search.trim() ? '没有找到匹配的房间' : '暂无房间'}</div>
          ) : (
            rooms.map(room => {
              const images = parseRoomImages(room.images);
              const cover = images[0];
              return (
                // 【需求2】原本整张卡片就是一个 <button>，若直接在内部再放「解散」按钮，
                // 会构成 HTML 非法的按钮嵌套，且点击解散时会连带触发进房跳转。
                // 故外层降级为 div 并保留键盘可达性，解散按钮用 stopPropagation 阻断冒泡。
                <div
                  key={room.id}
                  className="admin-room-item"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/room/${room.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/room/${room.id}`);
                    }
                  }}
                  title="点击进入房间（管理员无视密码）"
                >
                  {cover ? (
                    <img className="admin-room-cover" src={cover} alt={room.name} loading="lazy" />
                  ) : (
                    <span className="admin-room-cover admin-room-cover-empty">🎬</span>
                  )}
                  <span className="admin-room-info">
                    <span className="admin-room-name">
                      {room.name}
                      {room.hasPassword && <span className="admin-room-lock">🔒</span>}
                    </span>
                    <span className="admin-room-sub">
                      👤 {room.host.nickname || room.host.username}
                      {room.currentMovie ? ` · 🎬 ${room.currentMovie}` : ''}
                    </span>
                  </span>
                  <span className="admin-room-meta">
                    <span className={`status-badge ${room.status.toLowerCase()}`}>
                      {room.status === 'WAITING' ? '等待中' :
                       room.status === 'PLAYING' ? '播放中' : '已结束'}
                    </span>
                    <span className="admin-room-sub">👥 {room._count?.members || 0}/{room.maxViewers}</span>
                    <span className="admin-room-sub">{new Date(room.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                  <button
                    className="btn btn-danger btn-sm admin-room-dissolve"
                    onClick={(e) => { e.stopPropagation(); dissolveRoom(room); }}
                    title="解散该房间：房间及成员记录将被彻底删除，房间内用户会被立即请出"
                  >
                    🗑️ 解散
                  </button>
                </div>
              );
            })
          )}
        </div>
      ) : tab === 'publicRooms' ? (
        /* ===== 【公共房间需求】公共房间管理 ===== */
        <div className="admin-room-list card">
          {publicRooms.length === 0 ? (
            <div className="loading">暂无公共房间（用管理员账号创建一个房间即会出现在这里）</div>
          ) : (
            <div className="public-room-list">
              <p className="public-room-intro">
                公共房间由管理员账号创建，在大厅中永远置顶并显示为「🏛️ 公共放映厅」。
                它们<strong>不会自动消失</strong>（房间内无人也保留），只能在这里手动解散。
                「放映密码」是一次性密码：首位用户在放映通道使用后立即作废，
                本场结束（或放映人掉线超过 3 分钟）后需重新设置。
              </p>
              {publicRooms.map(room => {
                const stateText =
                  room.channelState === 'screening'
                    ? `放映中：${room.screeningUser || '未知用户'}`
                    : room.channelState === 'ready'
                      ? '密码待用（尚未被使用）'
                      : '未设密码（放映通道对所有人关闭）';
                const stateClass =
                  room.channelState === 'screening'
                    ? 'public-room-state-screening'
                    : room.channelState === 'ready'
                      ? 'public-room-state-ready'
                      : 'public-room-state-none';
                return (
                  <div key={room.id} className="public-room-item">
                    <div className="public-room-head">
                      <span className="admin-room-name">🏛️ {room.name}</span>
                      <span className={`public-room-state ${stateClass}`}>{stateText}</span>
                    </div>
                    <div className="public-room-meta">
                      <span className="admin-room-sub">👥 {room.memberCount}</span>
                      <span className={`status-badge ${room.status.toLowerCase()}`}>
                        {room.status === 'WAITING' ? '等待中' :
                         room.status === 'PLAYING' ? '播放中' : '已结束'}
                      </span>
                      <span className="admin-room-sub">创建者：{room.owner}</span>
                    </div>

                    <div className="public-room-actions">
                      <input
                        type="text"
                        className="input public-room-pwd-input"
                        placeholder="设置/重置放映密码（留空则清除并关闭通道）"
                        value={screeningInputs[room.id] || ''}
                        onChange={e => setScreeningInputs(prev => ({ ...prev, [room.id]: e.target.value }))}
                      />
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => setScreeningPassword(room, screeningInputs[room.id] || '')}
                      >
                        保存密码
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setScreeningPassword(room, '')}
                        title="清除放映密码：清除后放映通道对所有人关闭"
                      >
                        清除
                      </button>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => dissolvePublicRoom(room)}
                        title="解散该公共房间：房间及成员记录将被彻底删除"
                      >
                        🗑️ 解散
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : tab === 'users' ? (
        <div className="admin-table-wrap card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>邮箱</th>
                <th>最后 IP</th>
                <th>开设数量</th>
                <th>房间数</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className={u.banned ? 'row-banned' : ''}>
                  <td>
                    <div className="user-cell">
                      <span className="user-cell-avatar">
                        {(u.nickname || u.username).charAt(0).toUpperCase()}
                      </span>
                      <div>
                        <div className="user-cell-name">
                          {u.nickname || u.username}
                          {u.isAdmin && <span className="admin-badge">管理员</span>}
                        </div>
                        <div className="user-cell-username">@{u.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="cell-muted">{u.email}</td>
                  <td className="cell-muted">{u.lastIp || '-'}</td>
                  <td>
                    <div className="quota-cell">
                      <span className={u.maxRoomsPerIp === 0 ? 'warn-text' : ''} title={u.maxRoomsPerIp === 0 ? '禁止开设房间（仍可加入他人房间）' : '每个 IP 可同时开设的房间数'}>
                        {u.maxRoomsPerIp}
                      </span>
                      <button className="btn btn-secondary btn-sm" onClick={() => changeMaxRooms(u)}>
                        更改
                      </button>
                    </div>
                  </td>
                  <td className="cell-muted">{u._count?.rooms || 0}</td>
                  <td>
                    {u.banned ? (
                      <span className="status-pill banned" title={u.banReason || ''}>已封禁</span>
                    ) : (
                      <span className="status-pill normal">正常</span>
                    )}
                  </td>
                  <td>
                    {u.banned ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => unbanUser(u)}>
                        解除封禁
                      </button>
                    ) : (
                      !u.isAdmin && (
                        <div className="user-actions">
                          <button className="btn btn-danger btn-sm" onClick={() => banUser(u)}>
                            永久封禁
                          </button>
                          <button className="btn btn-outline-danger btn-sm" onClick={() => forceLogoutUser(u)}>
                            强制注销
                          </button>
                        </div>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="admin-table-wrap card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>IP 地址</th>
                <th>封禁原因</th>
                <th>封禁时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {bannedIps.length === 0 ? (
                <tr><td colSpan={4} className="cell-muted" style={{ textAlign: 'center' }}>暂无封禁的 IP</td></tr>
              ) : bannedIps.map(ip => (
                <tr key={ip.id}>
                  <td>{ip.ip}</td>
                  <td className="cell-muted">{ip.reason || '-'}</td>
                  <td className="cell-muted">{new Date(ip.createdAt).toLocaleString('zh-CN')}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => unbanIp(ip)}>
                      解除封禁
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
