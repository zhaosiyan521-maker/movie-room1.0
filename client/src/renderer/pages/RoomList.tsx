import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../store/authStore';
import './RoomList.css';

interface Room {
  id: string;
  name: string;
  description?: string;
  images?: string | null;
  status: string;
  /** 服务端只下发是否存在密码，不再下发明文密码 */
  hasPassword?: boolean;
  maxViewers: number;
  currentMovie?: string;
  host: {
    id: string;
    username: string;
    nickname: string;
  };
  _count: {
    members: number;
  };
  /** 【公共房间】是否管理员创建的公共房间（决定置顶 / 描边 / 双入口） */
  isPublicRoom?: boolean;
  /** 【公共房间】我此刻是否已有放映权限 */
  canScreen?: boolean;
  /** 【公共房间】放映通道当前是否可用（管理员恒可用；否则需已有人占位或密码待用） */
  screeningAvailable?: boolean;
}

interface SearchUser {
  id: string;
  username: string;
  nickname: string;
  _count?: { rooms: number };
}

export function parseRoomImages(images?: string | null): string[] {
  if (!images) return [];
  try {
    const arr = JSON.parse(images);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function RoomList() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');

  // 搜索
  const [keyword, setKeyword] = useState('');
  const [matchedUsers, setMatchedUsers] = useState<SearchUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<SearchUser | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 请求序号：只接受最新一次请求的结果，防止旧响应覆盖新状态
  const reqIdRef = useRef(0);

  // 输入防抖搜索用户
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!keyword.trim()) {
      setMatchedUsers([]);
      setSelectedUser(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.get(`/users/search?q=${encodeURIComponent(keyword.trim())}`);
        setMatchedUsers(data.users || []);
      } catch {
        setMatchedUsers([]);
      }
    }, 300);
    searchTimer.current = timer;
    // 捕获局部 timer，清理时不会读到过期的 ref 值
    return () => clearTimeout(timer);
  }, [keyword]);

  const fetchRooms = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    try {
      let list: Room[] = [];
      if (selectedUser) {
        // 查看指定用户开设的所有房间
        const { data } = await api.get(`/users/${selectedUser.id}/rooms`);
        list = data.rooms || [];
      } else {
        const params = new URLSearchParams();
        if (statusFilter !== 'all') params.set('status', statusFilter);
        if (keyword.trim()) params.set('search', keyword.trim());
        const { data } = await api.get(`/rooms?${params.toString()}`);
        list = data.rooms || [];
      }
      // 过期响应直接丢弃
      if (reqId !== reqIdRef.current) return;
      setRooms(list);
    } catch (error) {
      if (reqId !== reqIdRef.current) return;
      console.error('获取房间列表失败:', error);
      setRooms([]);
    } finally {
      // 仅由最新请求关闭 loading，避免仍在途时提前熄灭
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, [statusFilter, keyword, selectedUser]);

  // 房间查询同样防抖：原先每敲一个字符就触发一次请求
  useEffect(() => {
    const timer = setTimeout(fetchRooms, 400);
    return () => clearTimeout(timer);
  }, [fetchRooms]);

  /** 修改关键词时联动清空已选用户，避免残留筛选条件 */
  const onKeywordChange = (value: string) => {
    setKeyword(value);
    if (selectedUser) setSelectedUser(null);
  };

  const pickUser = (user: SearchUser) => {
    setSelectedUser(user);
    setMatchedUsers([]);
  };

  const clearSearch = () => {
    setKeyword('');
    setSelectedUser(null);
    setMatchedUsers([]);
  };

  // ===== 【公共房间需求】双入口选择 =====
  //
  // 公共房间点击卡片不再直接进入，而是先问用户走哪条路：
  //   「加入房间」→ 与普通房间完全一致的既有流程（/room/:id + 房间密码）
  //   「放映通道」→ 先向服务端换取放映权限，成功后再进房（进房后即显示房主控制面板）
  const [pickerRoom, setPickerRoom] = useState<Room | null>(null);
  const [screeningPass, setScreeningPass] = useState('');
  const [screeningError, setScreeningError] = useState('');
  const [screeningBusy, setScreeningBusy] = useState(false);

  const openPicker = (room: Room) => {
    setPickerRoom(room);
    setScreeningPass('');
    setScreeningError('');
    setScreeningBusy(false);
  };

  const closePicker = () => {
    if (screeningBusy) return;
    setPickerRoom(null);
    setScreeningPass('');
    setScreeningError('');
  };

  /** 走放映通道：先拿放映权限，再跳转到房间页 */
  const enterScreeningChannel = async () => {
    if (!pickerRoom || screeningBusy) return;
    setScreeningBusy(true);
    setScreeningError('');
    try {
      const { data } = await api.post(`/rooms/${pickerRoom.id}/screening`, {
        password: screeningPass
      });
      if (data?.canScreen) {
        setPickerRoom(null);
        setScreeningPass('');
        navigate(`/room/${pickerRoom.id}`);
        return;
      }
      setScreeningError('进入放映通道失败，请稍后重试');
    } catch (e: any) {
      setScreeningError(e?.response?.data?.error || '进入放映通道失败');
    } finally {
      setScreeningBusy(false);
    }
  };

  return (
    <div className="room-list-page fade-in">
      <div className="page-header">
        <h1>🎬 观影房间</h1>
        <p>选择一个房间，与好友一起看电影</p>
      </div>

      <div className="room-list-layout">
        {/* 左侧：搜索栏 */}
        <aside className="room-search-sidebar">
          <div className="search-box">
            <input
              type="text"
              className="input search-input"
              placeholder="🔍 搜索房间 / 昵称 / 用户名"
              value={keyword}
              onChange={(e) => onKeywordChange(e.target.value)}
            />
            {(keyword || selectedUser) && (
              <button className="search-clear" onClick={clearSearch} title="清除搜索">✕</button>
            )}
          </div>

          {/* 匹配到的用户 */}
          {matchedUsers.length > 0 && (
            <div className="search-users">
              <p className="search-users-title">👤 匹配的用户</p>
              {matchedUsers.map(u => (
                <button key={u.id} className="search-user-item" onClick={() => pickUser(u)}>
                  <span className="search-user-avatar">
                    {(u.nickname || u.username).charAt(0).toUpperCase()}
                  </span>
                  <span className="search-user-info">
                    <span className="search-user-name">{u.nickname || u.username}</span>
                    <span className="search-user-username">@{u.username}</span>
                  </span>
                  <span className="search-user-rooms">{u._count?.rooms || 0} 个房间</span>
                </button>
              ))}
            </div>
          )}

          {selectedUser && (
            <div className="search-selected-user">
              正在查看「{selectedUser.nickname || selectedUser.username}」开设的所有房间
              <button className="link-btn" onClick={clearSearch}>返回全部</button>
            </div>
          )}

          {/* 状态筛选 */}
          <div className="filter-bar-vertical">
            <button
              className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              全部
            </button>
            <button
              className={`filter-btn ${statusFilter === 'WAITING' ? 'active' : ''}`}
              onClick={() => setStatusFilter('WAITING')}
            >
              等待中
            </button>
            <button
              className={`filter-btn ${statusFilter === 'PLAYING' ? 'active' : ''}`}
              onClick={() => setStatusFilter('PLAYING')}
            >
              播放中
            </button>
          </div>
        </aside>

        {/* 右侧：房间网格 */}
        <div className="room-list-main">
          {loading ? (
            <div className="loading">加载中...</div>
          ) : rooms.length === 0 ? (
            <div className="empty-state">
              <p>{keyword || selectedUser ? '没有找到匹配的房间' : '暂无房间'}</p>
              {!keyword && !selectedUser && (
                <Link to="/create" className="btn btn-primary">创建第一个房间</Link>
              )}
            </div>
          ) : (
            <div className="room-grid">
              {rooms.map((room) => {
                const images = parseRoomImages(room.images);
                const isPublic = room.isPublicRoom === true;
                const cardClass = `room-card card${isPublic ? ' room-card-public' : ''}`;
                // 公共房间的卡片内容（与普通房间一致，仅创建人一栏与描边不同）
                const inner = (
                  <>
                    {images.length > 0 && (
                      <div className="room-card-cover">
                        <img src={images[0]} alt={room.name} loading="lazy" />
                        {images.length > 1 && (
                          <span className="cover-count">🖼️ {images.length}</span>
                        )}
                      </div>
                    )}
                    <div className="room-card-header">
                      <span className={`status-badge ${room.status.toLowerCase()}`}>
                        {room.status === 'WAITING' ? '等待中' :
                         room.status === 'PLAYING' ? '播放中' : '已结束'}
                      </span>
                    </div>

                    <h3 className="room-name">{room.name}</h3>
                    {room.description && (
                      <p className="room-desc">{room.description}</p>
                    )}

                    <div className="room-meta">
                      <span className="host-name">
                        {/* 【公共房间需求】公共房间不显示创建人（管理员），统一显示「公共放映厅」 */}
                        {isPublic ? '🏛️ 公共放映厅' : `👤 ${room.host.nickname || room.host.username}`}
                      </span>
                      <span className="viewer-count">
                        👥 {room._count.members}/{room.maxViewers}
                      </span>
                    </div>

                    <div className="room-tags">
                      {room.hasPassword && <span className="tag">🔒 需要密码</span>}
                      {room.currentMovie && <span className="tag">🎬 {room.currentMovie}</span>}
                    </div>
                  </>
                );

                // 【公共房间需求】公共房间点击后弹「放映通道 / 加入房间」选择，不直接进入
                return isPublic ? (
                  <div
                    key={room.id}
                    className={cardClass}
                    role="button"
                    tabIndex={0}
                    onClick={() => openPicker(room)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openPicker(room); }}
                  >
                    {inner}
                  </div>
                ) : (
                  <Link to={`/room/${room.id}`} key={room.id} className={cardClass}>
                    {inner}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 【公共房间需求】双入口选择弹层 */}
      {pickerRoom && (
        <div className="modal-mask" onClick={closePicker}>
          <div className="modal-card screening-picker" onClick={e => e.stopPropagation()}>
            <h3 className="screening-title">🏛️ {pickerRoom.name}</h3>
            <p className="screening-sub">请选择进入方式</p>

            {/* 入口二：与普通房间完全一致的既有流程（房间普通密码仍由房间页处理） */}
            <button
              className="btn btn-secondary screening-option"
              onClick={() => navigate(`/room/${pickerRoom.id}`)}
            >
              🚪 加入房间
            </button>

            <div className="screening-divider" />

            {/* 入口一：放映通道 —— 通过后获得放映权限（≈房主，但不可解散房间） */}
            <p className="screening-channel-label">🎬 放映通道（获得放映权限）</p>
            <div className="screening-pass-row">
              <input
                type="password"
                className="input"
                placeholder="放映密码"
                value={screeningPass}
                onChange={e => setScreeningPass(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') enterScreeningChannel(); }}
                disabled={screeningBusy}
              />
              <button
                className="btn btn-primary"
                onClick={enterScreeningChannel}
                disabled={screeningBusy}
              >
                {screeningBusy ? '验证中…' : '进入'}
              </button>
            </div>

            {screeningError && <p className="screening-error">{screeningError}</p>}
            <p className="screening-hint">
              放映密码为一次性密码，由管理员设置；管理员本人无需密码
            </p>

            <div className="screening-foot">
              <button className="btn btn-secondary" onClick={closePicker} disabled={screeningBusy}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
