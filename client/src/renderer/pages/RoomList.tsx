import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
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
                return (
                  <Link to={`/room/${room.id}`} key={room.id} className="room-card card">
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
                        👤 {room.host.nickname || room.host.username}
                      </span>
                      <span className="viewer-count">
                        👥 {room._count.members}/{room.maxViewers}
                      </span>
                    </div>

                    <div className="room-tags">
                      {room.hasPassword && <span className="tag">🔒 需要密码</span>}
                      {room.currentMovie && <span className="tag">🎬 {room.currentMovie}</span>}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
