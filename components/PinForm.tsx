"use client";

// Hỏi PIN khi vào phòng có khóa, dùng chung bốn game. Mỗi game truyền class của mình và tự đặt đầu form (tên game, mã phòng).

import { useState, type FormEvent, type ReactNode } from "react";

export type PinProblem = "pin" | "pin-wait";

const PROBLEM_TEXT: Record<PinProblem, string> = {
  pin: "PIN chưa đúng",
  "pin-wait": "Nhập sai nhiều lần, đợi 10 phút rồi thử lại",
};

type Classes = { form: string; input: string; button: string; problem: string };

export function PinForm({ problem, onSubmit, classes, children }: { problem: PinProblem | null; onSubmit: (pin: string) => void; classes: Classes; children: ReactNode }) {
  const [pin, setPin] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(pin);
  };

  return (
    <form className={classes.form} onSubmit={submit}>
      {children}
      <input
        className={classes.input}
        aria-label="PIN 4 số"
        placeholder="PIN 4 số"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
        autoFocus
      />
      <button type="submit" className={classes.button} disabled={pin.length !== 4}>
        Vào phòng
      </button>
      {problem && (
        <p className={classes.problem} role="alert">
          {PROBLEM_TEXT[problem]}
        </p>
      )}
    </form>
  );
}
