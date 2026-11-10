"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ServerPicker, createRoomProblem } from "@/components/ServerPicker";
import { GAME_ROOMS, openRoom, useCanCreate } from "@/games/town/rooms";

/** Chỉ người có tài khoản mới mở được phòng; khách vẫn vào phòng bằng mã. */
const LOGIN = "/dang-nhap?next=/co-ty-phu";

export default function CoTyPhuHomePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [server, setServer] = useState(1);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = useCanCreate();

  // Phòng mở ở đây không hiện trong danh sách thị trấn; chủ phòng bật lên được trong phòng chờ.
  const createRoom = async () => {
    setCreating(true);
    setError(null);
    const result = await openRoom("co-ty-phu", { listed: false, server });
    if ("code" in result) {
      router.push(GAME_ROOMS["co-ty-phu"].hostPage(result.code));
    } else if (result.problem === "signed-out") {
      router.push(LOGIN);
    } else {
      setError(createRoomProblem(server));
      setCreating(false);
    }
  };

  const joinRoom = (event: FormEvent) => {
    event.preventDefault();
    router.push(`/co-ty-phu/${code.trim().toUpperCase()}`);
  };

  return (
    <main className="tp tp--center">
      <div className="tp-join">
        <div className="tp-home__dice" aria-hidden="true">
          <span className="tp-die">
            <i />
            <i />
            <i className="tp-die__pip" />
            <i />
            <i className="tp-die__pip" />
            <i />
            <i className="tp-die__pip" />
            <i />
            <i />
          </span>
          <span className="tp-die">
            <i className="tp-die__pip" />
            <i />
            <i className="tp-die__pip" />
            <i />
            <i className="tp-die__pip" />
            <i />
            <i className="tp-die__pip" />
            <i />
            <i className="tp-die__pip" />
          </span>
        </div>
        <h1 className="tp-logo">Cờ tỷ phú</h1>
        <p className="tp-lede">Mua đất từ Lạng Sơn tới Quận 1, xây nhà, thu tiền thuê. Từ 2 tới 6 người, mỗi người một điện thoại.</p>
        <ServerPicker server={server} onChange={setServer} className="tp-segments" />
        {canCreate === false ? (
          <Link className="tp-btn tp-btn--main tp-btn--big" href={LOGIN}>
            Đăng nhập để mở phòng
          </Link>
        ) : (
          <button type="button" className="tp-btn tp-btn--main tp-btn--big" disabled={creating || canCreate === null} onClick={createRoom}>
            {creating ? "Đang tạo phòng…" : "Tạo phòng"}
          </button>
        )}
        {error && <p className="tp-problem">{error}</p>}
        <form className="tp-home__join" onSubmit={joinRoom}>
          <label htmlFor="tp-code">Có mã phòng rồi?</label>
          <input
            id="tp-code"
            className="tp-input tp-input--code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={4}
            pattern="[A-Za-z0-9]{4}"
            title="Mã phòng gồm 4 ký tự"
            autoCapitalize="characters"
            autoComplete="off"
            required
          />
          <button type="submit" className="tp-btn">
            Vào phòng
          </button>
        </form>
        <Link className="tp-link" href="/thi-tran">
          ← Về thị trấn
        </Link>
        <Link className="tp-link" href="/choi-nhanh">
          Chọn trò chơi khác
        </Link>
      </div>
    </main>
  );
}
