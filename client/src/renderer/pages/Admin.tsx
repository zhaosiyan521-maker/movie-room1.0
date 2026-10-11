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
  abruptLeaves: number;
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

export default function Admin() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [bannedIps, setBannedIps] = useState<BannedIp[]>([]);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // 消息带类型：原先所有消息（含「封禁失败」）都用 success 绿色样式渲染，
  // 管理员会看到一片绿色的失败提示，误判操作已生效。
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<'users' | 'ips' | 'rooms'>('users');

  // 请求序号：只采纳最新请求结果，防止旧响应覆盖新状态
  const reqIdRef = useRef(0);

  const fetchAll = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      const params = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      // 搜索时无需拉取与搜索无关的封禁 IP 列表（原实现每次按键都会多打一个请求）
      if (tab === 'rooms') {
        const { data: roomsData } = await api.get(`/admin/rooms${params}`);
        if (reqId !== reqIdRef.current) return;
        setRooms(roomsData.rooms || []);
      } else if (params) {
        const { data: usersData } = await api.get(`/admin/users${params}`);
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

  return (
    <div className="admin-page fade-in">
      <h1>🛡️ 管理员后台</h1>

      <div className="admin-toolbar">
        <div className="filter-bar">
          <button className={`filter-btn ${tab === 'users' ? 'active' : ''}`} onClick={() => setTab('users')}>
            👥 用户管理 ({users.length})
          </button>
          <button className={`filter-btn ${tab === 'ips' ? 'active' : ''}`} onClick={() => setTab('ips')}>
            🚫 封禁 IP ({bannedIps.length})
          </button>
          <button className={`filter-btn ${tab === 'rooms' ? 'active' : ''}`} onClick={() => { setTab('rooms'); setSearch(''); }}>
            🏠 房间列表 ({rooms.length})
          </button>
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
      ) : tab === 'rooms' ? (
        <div className="admin-room-list card">
          {rooms.length === 0 ? (
            <div className="loading">{search.trim() ? '没有找到匹配的房间' : '暂无房间'}</div>
          ) : (
            rooms.map(room => {
              const images = parseRoomImages(room.images);
              const cover = images[0];
              return (
                <button
                  key={room.id}
                  className="admin-room-item"
                  onClick={() => navigate(`/room/${room.id}`)}
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
                </button>
              );
            })
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
                <th>中断次数</th>
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
                    <span className={u.abruptLeaves >= 2 ? 'warn-text' : ''}>
                      {u.abruptLeaves} 次
                    </span>
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
