import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../store/authStore';
import {
  MAX_ROOM_IMAGES,
  compressImageFiles,
} from '../utils/roomImages';
import './RoomList.css';
import './CreateRoom.css';

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
  /** 【新需求】本场我是否已经改过房间信息（改过则跳过编辑弹窗） */
  hasEditedThisSession?: boolean;
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
  /** 【新需求】我此刻是否就是本厅放映人（是则隐藏「加入房间」） */
  isScreeningHost?: boolean;
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

  // ===== 【公共房间需求】三步弹窗 =====
  //
  // 弹窗①（选择进入方式）：房名 + 房主/观众 + 「加入房间」「放映通道」「返回列表」
  // 弹窗②（输入密码，严格按设计稿）：只在走放映通道时出现
  // 弹窗③（编辑房间信息）：密码校验通过后弹一次；本场已改过则跳过
  const [pickerRoom, setPickerRoom] = useState<Room | null>(null);
  const [showPassModal, setShowPassModal] = useState(false);
  const [screeningPass, setScreeningPass] = useState('');
  const [screeningError, setScreeningError] = useState('');
  const [screeningBusy, setScreeningBusy] = useState(false);

  // 弹窗③的表单（字段与「创建房间」一致）
  const [editRoom, setEditRoom] = useState<Room | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', password: '', maxViewers: 30 });
  const [editImages, setEditImages] = useState<string[]>([]);
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const editFileRef = useRef<HTMLInputElement>(null);

  const openPicker = (room: Room) => {
    setPickerRoom(room);
    setShowPassModal(false);
    setScreeningPass('');
    setScreeningError('');
    setScreeningBusy(false);
  };

  const closeAll = () => {
    if (screeningBusy || editSaving) return;
    setPickerRoom(null);
    setShowPassModal(false);
    setEditRoom(null);
    setScreeningPass('');
    setScreeningError('');
  };

  /** 点「放映通道」：关闭弹窗①，打开弹窗②（输入密码） */
  const openPassModal = () => {
    setShowPassModal(true);
    setScreeningPass('');
    setScreeningError('');
  };

  /** 弹窗②「返回列表」：关闭全部弹窗 */
  const backToList = () => {
    if (screeningBusy) return;
    setPickerRoom(null);
    setShowPassModal(false);
    setEditRoom(null);
    setScreeningPass('');
    setScreeningError('');
  };

  /** 打开编辑房间弹窗（用房间当前信息预填） */
  const openEditModal = (room: Room) => {
    setEditRoom(room);
    setEditForm({
      name: room.name || '',
      description: room.description || '',
      password: '',
      maxViewers: room.maxViewers || 30,
    });
    // 已有图片回填（它们是 /uploads 下的相对地址，直接可预览）
    setEditImages(Array.isArray(parseRoomImages(room.images)) ? parseRoomImages(room.images) : []);
    setEditError('');
  };

  /**
   * 弹窗②「进入放映厅」：校验密码 → 拿到放映权限 → 进房。
   * 若本场尚未编辑过房间信息，先弹弹窗③；已改过则直接进房。
   */
  const enterScreeningChannel = async () => {
    if (!pickerRoom || screeningBusy) return;
    setScreeningBusy(true);
    setScreeningError('');
    try {
      const { data } = await api.post(`/rooms/${pickerRoom.id}/screening`, {
        password: screeningPass
      });
      if (!data?.canScreen) {
        setScreeningError('进入放映厅失败，请稍后重试');
        return;
      }
      // 需求：每人每场只能改一次，改过之后再进来自动跳过编辑弹窗
      if (data.hasEditedThisSession) {
        const id = pickerRoom.id;
        setPickerRoom(null);
        setShowPassModal(false);
        setScreeningPass('');
        navigate(`/room/${id}`);
        return;
      }
      // 先关掉密码弹窗，再弹出编辑房间弹窗
      setShowPassModal(false);
      setScreeningPass('');
      openEditModal(pickerRoom);
    } catch (e: any) {
      setScreeningError(e?.response?.data?.error || '进入放映厅失败');
    } finally {
      setScreeningBusy(false);
    }
  };

  /** 弹窗③：图片选择（与创建房间同一套压缩逻辑） */
  const handleEditImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const remaining = MAX_ROOM_IMAGES - editImages.length;
    if (remaining <= 0) {
      setEditError(`最多只能添加 ${MAX_ROOM_IMAGES} 张图片`);
      if (editFileRef.current) editFileRef.current.value = '';
      return;
    }
    const { ok, failed } = await compressImageFiles(files, remaining);
    if (ok.length) setEditImages(prev => [...prev, ...ok]);
    setEditError(failed > 0 ? `${failed} 张图片处理失败（可能过大或格式不支持），其余已添加` : '');
    if (editFileRef.current) editFileRef.current.value = '';
  };

  /** 弹窗③「确认」：覆盖房间信息 + 图片，然后进入房间 */
  const confirmEditRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editRoom || editSaving) return;
    setEditError('');
    setEditSaving(true);
    try {
      await api.patch(`/rooms/${editRoom.id}`, {
        name: editForm.name,
        description: editForm.description || null,
        // 语义（与占位提示一致）：留空 = 保持原密码不变；
        // 填了新值 = 覆盖为新密码。这样用户不会因为"没动密码框"而意外清掉密码。
        ...(editForm.password ? { password: editForm.password } : {}),
        maxViewers: editForm.maxViewers,
      });
      // 图片走独立接口（那里已有跨房间引用检查与旧文件清理）
      await api.put(`/rooms/${editRoom.id}/images`, { images: editImages });

      const id = editRoom.id;
      setEditRoom(null);
      setPickerRoom(null);
      setShowPassModal(false);
      // 刷新列表，让大厅立刻反映新房间信息
      fetchRooms();
      navigate(`/room/${id}`);
    } catch (err: any) {
      setEditError(err?.response?.data?.error || '保存房间信息失败');
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div className="room-list-page fade-in">
      <div className="page-header">
        <h1>🎬 观影房间</h1>
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

      {/* ===== 弹窗①：选择进入方式（房名 + 房主/观众 + 三个按钮）===== */}
      {pickerRoom && !showPassModal && !editRoom && (
        <div className="modal-mask" onClick={closeAll}>
          <div className="modal-card card screening-picker" onClick={e => e.stopPropagation()}>
            <h3 className="screening-roomname">{pickerRoom.name}</h3>

            <div className="screening-roominfo">
              <p>👤 房主：{pickerRoom.host.nickname || pickerRoom.host.username}</p>
              <p>👥 观众：{pickerRoom._count.members}/{pickerRoom.maxViewers}</p>
            </div>

            {/* 【新需求】已经是本厅放映人时隐藏「加入房间」：
                走那条路会被服务端拒绝，且他本来就该走放映通道恢复身份。 */}
            {!pickerRoom.isScreeningHost && (
              <button
                className="btn btn-primary btn-block screening-option"
                /* 带上 autoJoin 意图：用户在弹窗里已经明确点了「加入房间」，
                   房间页不应再渲染一次同样三个按钮的加入卡片让他点第二遍
                   （那会让用户以为"又弹出了加入房间弹窗"）。 */
                onClick={() => navigate(`/room/${pickerRoom.id}`, { state: { autoJoin: true } })}
              >
                加入房间
              </button>
            )}

            <button
              className="btn btn-primary btn-block screening-option"
              onClick={openPassModal}
            >
              放映通道
            </button>

            <button className="btn btn-secondary btn-block screening-option" onClick={closeAll}>
              返回列表
            </button>
          </div>
        </div>
      )}

      {/* ===== 弹窗②：输入密码（UI 与文案严格按设计稿）===== */}
      {pickerRoom && showPassModal && !editRoom && (
        <div className="modal-mask" onClick={backToList}>
          <div className="modal-card card screening-pass-modal" onClick={e => e.stopPropagation()}>
            <h3 className="screening-passtitle">输入密码</h3>

            <input
              type="password"
              className="input screening-passinput"
              placeholder="请输入密码"
              value={screeningPass}
              onChange={e => setScreeningPass(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') enterScreeningChannel(); }}
              disabled={screeningBusy}
            />

            <p className="screening-pashint">请向管理员索要密码</p>

            {screeningError && <p className="screening-error">{screeningError}</p>}

            <button
              className="btn btn-primary btn-block screening-option"
              onClick={enterScreeningChannel}
              disabled={screeningBusy}
            >
              进入放映厅
            </button>

            <button
              className="btn btn-secondary btn-block screening-option"
              onClick={backToList}
              disabled={screeningBusy}
            >
              返回列表
            </button>
          </div>
        </div>
      )}

      {/* ===== 弹窗③：编辑房间信息（与「创建房间」同一套表单，按钮为「确认」）===== */}
      {editRoom && (
        <div className="modal-mask" onClick={() => { /* 必须保存或取消，点遮罩不关 */ }}>
          <div className="modal-card card edit-room-modal" onClick={e => e.stopPropagation()}>
            <h3 className="edit-room-title">修改房间信息</h3>
            <form onSubmit={confirmEditRoom}>
              <div className="form-group">
                <label className="label">房间名称 *</label>
                <input
                  type="text"
                  className="input"
                  value={editForm.name}
                  onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="例如：周末电影之夜"
                  maxLength={50}
                  required
                />
              </div>

              <div className="form-group">
                <label className="label">房间描述</label>
                <textarea
                  className="input textarea"
                  value={editForm.description}
                  onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="简单描述一下要播放的电影或活动..."
                  rows={3}
                />
              </div>

              <div className="form-group">
                <label className="label">房间图片（最多 {MAX_ROOM_IMAGES} 张，观众在房间外可见）</label>
                <input
                  ref={editFileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleEditImages}
                />
                <div className="image-picker">
                  {editImages.map((img, idx) => (
                    <div key={img + idx} className="image-preview">
                      <img src={img} alt={`房间图片 ${idx + 1}`} />
                      <button
                        type="button"
                        className="image-remove"
                        onClick={() => setEditImages(p => p.filter((_, i) => i !== idx))}
                        title="删除图片"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {editImages.length < MAX_ROOM_IMAGES && (
                    <button
                      type="button"
                      className="image-add-btn"
                      onClick={() => editFileRef.current?.click()}
                    >
                      <span className="image-add-icon">🖼️</span>
                      <span>添加图片</span>
                      <span className="image-add-count">{editImages.length}/{MAX_ROOM_IMAGES}</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label className="label">入场密码（可选）</label>
                <input
                  type="password"
                  className="input"
                  value={editForm.password}
                  onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))}
                  placeholder={editRoom.hasPassword ? '留空表示保持原密码不变' : '留空表示不需要密码'}
                />
                <span className="hint">设置密码后，观众需要输入密码才能加入</span>
              </div>

              <div className="form-group">
                <label className="label">最大观众数</label>
                <select
                  className="input"
                  value={editForm.maxViewers}
                  onChange={e => setEditForm(p => ({ ...p, maxViewers: Number(e.target.value) }))}
                >
                  {[5, 10, 15, 20, 25, 30].map(n => (
                    <option key={n} value={n}>{n} 人</option>
                  ))}
                </select>
              </div>

              {editError && <div className="error-message">{editError}</div>}

              <div className="edit-room-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditRoom(null)}
                  disabled={editSaving}
                >
                  取消
                </button>
                <button type="submit" className="btn btn-primary" disabled={editSaving}>
                  {editSaving ? '保存中…' : '确认'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
