'use strict';

/**
 * 增量解析流式返回的候选 JSON。
 *
 * 模型是一边想一边吐 JSON 的，所以我们不能等全部结束再 JSON.parse，
 * 而是在字符流里数括号：当「候选」数组里的某个对象闭合（深度回到 0）时，
 * 就认为这一条候选已经完整，可以立刻推给前端。
 *
 * 只做括号/字符串状态跟踪，不做猜测：括号没闭合就继续等。
 */

class CandidateStreamParser {
  constructor() {
    this.buffer = '';
    this.pos = 0;
    this.arrayStart = -1;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.objectStart = -1;
    this.finished = false;
  }

  /** 找到候选数组的起点：优先 "候选": [，其次第一个 [ */
  locateArray() {
    const keyIndex = this.buffer.indexOf('"候选"');
    if (keyIndex >= 0) {
      const bracket = this.buffer.indexOf('[', keyIndex);
      if (bracket >= 0) {
        this.arrayStart = bracket;
        this.pos = bracket + 1;
        return true;
      }
      return false;
    }
    const trimmed = this.buffer.replace(/^\s*/, '');
    if (trimmed.startsWith('[')) {
      this.arrayStart = this.buffer.indexOf('[');
      this.pos = this.arrayStart + 1;
      return true;
    }
    return false;
  }

  /**
   * 推入一段增量文本，返回本次新识别出的完整候选对象数组。
   */
  push(chunk) {
    if (this.finished || !chunk) return [];
    this.buffer += chunk;
    const completed = [];

    if (this.arrayStart < 0 && !this.locateArray()) return completed;

    while (this.pos < this.buffer.length) {
      const char = this.buffer[this.pos];

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        this.pos += 1;
        continue;
      }

      if (char === '"') {
        this.inString = true;
        this.pos += 1;
        continue;
      }

      if (char === '{') {
        if (this.depth === 0) this.objectStart = this.pos;
        this.depth += 1;
        this.pos += 1;
        continue;
      }

      if (char === '}') {
        if (this.depth > 0) {
          this.depth -= 1;
          if (this.depth === 0 && this.objectStart >= 0) {
            const raw = this.buffer.slice(this.objectStart, this.pos + 1);
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') completed.push(parsed);
            } catch {
              // 单条解析失败就跳过，不中断整体
            }
            this.objectStart = -1;
          }
        }
        this.pos += 1;
        continue;
      }

      // 数组结束：候选已经收完
      if (char === ']' && this.depth === 0) {
        this.finished = true;
        this.pos += 1;
        break;
      }

      this.pos += 1;
    }

    return completed;
  }

  /** 流结束时兜底：万一数组没闭合，尝试整体解析一次 */
  finalize() {
    if (this.finished) return [];
    this.finished = true;
    const start = this.arrayStart >= 0 ? this.buffer.indexOf('[', this.arrayStart) : this.buffer.indexOf('[');
    if (start < 0) return [];
    const end = this.buffer.lastIndexOf(']');
    if (end <= start) return [];
    try {
      const parsed = JSON.parse(this.buffer.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

module.exports = { CandidateStreamParser };
