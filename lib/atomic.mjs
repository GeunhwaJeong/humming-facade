// 크래시 내성 파일 쓰기. write(대상) 직접 쓰기는 도중에 프로세스가 죽으면
// "반쯤 쓰인" 파일을 남긴다 — 수탁 키·계정처럼 복구 불가능한 상태 파일에는 치명적.
// 여기서는 tmp에 전부 쓰고 fsync로 디스크 도달을 보장한 뒤 rename으로 교체한다.
// rename은 같은 파일시스템 안에서 원자적이므로, 어느 시점에 죽어도 대상 파일은
// 완전한 구버전 아니면 완전한 신버전으로만 존재한다. (journal.mjs의 커서 저장이
// 쓰던 패턴을 fsync 포함으로 일반화한 것)
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function writeFileAtomic(dest, data, { mode = 0o600 } = {}) {
  const destPath = dest instanceof URL ? fileURLToPath(dest) : dest
  const tmpPath = `${destPath}.tmp`
  // 'w'의 mode는 파일 신규 생성 시에만 적용 — 이전 크래시로 남은 tmp를 재사용하는
  // 경우를 위해 chmod로 한 번 더 못박는다.
  const fd = fs.openSync(tmpPath, 'w', mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(tmpPath, mode)
  fs.renameSync(tmpPath, destPath)
}
