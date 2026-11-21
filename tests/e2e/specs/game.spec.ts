import { expect, test, type Page } from '@playwright/test';

const BOARD_SIZE = 8;

interface StoredSessionPiece {
  cells: Array<[number, number]>;
}

interface StoredSession {
  board: Array<Array<string | null>>;
  combo: number;
  gameOver: boolean;
  pieces: Array<StoredSessionPiece | null>;
  score: number;
}

async function readAudioPlays(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __superBlocksAudioPlays?: string[] })
        .__superBlocksAudioPlays ?? []
  );
}

async function readSession(page: Page): Promise<StoredSession> {
  const session = await page.evaluate(() => {
    const stored = window.sessionStorage.getItem('block-blast-active-game');
    return stored ? JSON.parse(stored) : null;
  });
  expect(session).not.toBeNull();
  return session as StoredSession;
}

async function injectSession(page: Page, session: unknown) {
  await page.evaluate((value) => {
    window.sessionStorage.setItem(
      'block-blast-active-game',
      JSON.stringify(value)
    );
  }, session);
}

function findValidPlacement(session: StoredSession) {
  for (
    let pieceIndex = 0;
    pieceIndex < session.pieces.length;
    pieceIndex += 1
  ) {
    const piece = session.pieces[pieceIndex];
    if (!piece) continue;
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let column = 0; column < BOARD_SIZE; column += 1) {
        const fits = piece.cells.every(([cellRow, cellColumn]) => {
          const targetRow = row + cellRow;
          const targetColumn = column + cellColumn;
          return (
            targetRow < BOARD_SIZE &&
            targetColumn < BOARD_SIZE &&
            session.board[targetRow][targetColumn] === null
          );
        });
        if (fits) return { column, pieceIndex, row };
      }
    }
  }
  return null;
}

function createCraftedSession(
  overrides: Record<string, unknown> & {
    board: Array<Array<string | null>>;
    pieces: unknown;
  }
) {
  return {
    challengeComplete: false,
    combo: 0,
    dailyDate: null,
    elapsedSeconds: 12,
    gameOver: false,
    generation: 4,
    mode: 'classic',
    movesWithoutClear: 0,
    score: 100,
    seed: 99,
    version: 4,
    ...overrides,
  };
}

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array<string | null>(BOARD_SIZE).fill(null)
  );
}

async function preparePage(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript(() => {
    const audioWindow = window as Window & {
      __superBlocksAudioPlays?: string[];
    };
    audioWindow.__superBlocksAudioPlays = [];
    HTMLMediaElement.prototype.play = function play() {
      audioWindow.__superBlocksAudioPlays?.push(
        new URL(this.src, window.location.href).pathname
      );
      return Promise.resolve();
    };

    if (window.sessionStorage.getItem('block-blast-e2e-ready')) {
      return;
    }
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('block-blast-')) {
        window.localStorage.removeItem(key);
      }
    }
    window.localStorage.setItem('block-blast-language', 'en');
    window.localStorage.setItem('block-blast-score-version', '3');
    window.sessionStorage.removeItem('block-blast-active-game');
    window.sessionStorage.setItem('block-blast-e2e-ready', 'true');
  });

  return errors;
}

async function openHome(page: Page) {
  const errors = await preparePage(page);
  await page.goto('/');
  await expect(page.getByTestId('block-game')).toHaveAttribute(
    'data-ready',
    'true'
  );
  return errors;
}

async function placePiece(
  page: Page,
  pieceIndex: number,
  row: number,
  column: number
) {
  await page.getByTestId(`game-piece-${pieceIndex}`).click();
  await page.getByTestId(`board-cell-${row}-${column}`).click();
}

test.describe('Super Blocks', () => {
  test('opens directly on the game menu', async ({ page }) => {
    const errors = await openHome(page);

    await expect(page).toHaveTitle('Super Blocks');
    await expect(page.getByRole('img', { name: 'Super Blocks' })).toBeVisible();
    await expect(page.getByTestId('start-classic')).toBeVisible();
    await expect(page.getByTestId('start-daily')).toBeVisible();
    await expect(page.getByTestId('home-ranking')).toContainText(
      'View your best score for each mode.'
    );
    await expect(page.getByTestId('home-settings')).toBeVisible();
    await expect(page.getByTestId('home-how-to-play')).toBeVisible();
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      '/og.png'
    );
    await expect(
      page.locator('link[rel="icon"][sizes="32x32"]')
    ).toHaveAttribute('href', '/favicon-32x32.png');
    expect(errors).toEqual([]);
  });

  test('dragged piece follows the pointer and can be dropped', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();

    const piece = page.getByTestId('game-piece-0');
    const shape = piece.locator('.piece-shape');
    const target = page.getByTestId('board-cell-3-3');
    const pieceBox = await piece.boundingBox();
    const targetBox = await target.boundingBox();

    expect(pieceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!pieceBox || !targetBox) return;

    const pointerStart = {
      x: pieceBox.x + pieceBox.width / 2,
      y: pieceBox.y + pieceBox.height / 2,
    };
    const pointerEnd = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };

    await page.mouse.move(pointerStart.x, pointerStart.y);
    await page.mouse.down();
    await page.mouse.move(pointerEnd.x, pointerEnd.y, { steps: 12 });

    const draggedShapeBox = await shape.boundingBox();
    expect(draggedShapeBox).not.toBeNull();
    if (!draggedShapeBox) return;

    const draggedShapeCenter = {
      x: draggedShapeBox.x + draggedShapeBox.width / 2,
      y: draggedShapeBox.y + draggedShapeBox.height / 2,
    };
    expect(
      Math.hypot(
        pointerEnd.x - draggedShapeCenter.x,
        pointerEnd.y - draggedShapeCenter.y
      )
    ).toBeLessThan(12);
    await expect(page.locator('.is-preview-valid')).toHaveCount(3);

    await page.mouse.up();
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('plays a deterministic classic round and saves the score', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.locator('[data-testid^="game-piece-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid^="board-cell-"]')).toHaveCount(64);

    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    await placePiece(page, 1, 0, 3);
    await expect(page.getByTestId('game-score')).toHaveText('6');
    await placePiece(page, 2, 0, 6);
    await expect(page.getByTestId('clear-effect')).toHaveAttribute(
      'data-line-count',
      '1'
    );
    await expect(page.getByTestId('game-score')).toHaveText('18');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-best-score'))
      )
      .toBe('18');
    expect(errors).toEqual([]);
  });

  test('restores an active game after reload', async ({ page }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');

    await page.reload();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(3);

    await page.goto('/');
    await expect(page).toHaveURL(/\/play\/classic$/);
    expect(errors).toEqual([]);
  });

  test('returns from settings through browser history without source params', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await page.getByRole('link', { name: 'Settings' }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page).not.toHaveURL(/[?&]from=/);
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    expect(errors).toEqual([]);
  });

  test('omits descriptive text below the how-to-play and settings titles', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-how-to-play').click();
    await expect(page).toHaveURL(/\/how-to-play$/);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);

    await page.goto('/');
    await page.getByTestId('home-settings').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('persists language and independent preferences', async ({ page }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-settings').click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.getByRole('button', { name: /中文/ }).click();
    await expect(page.getByRole('heading', { name: '游戏设置' })).toBeVisible();
    await page.getByRole('button', { name: /背景音乐/ }).click();
    await page.getByRole('button', { name: /音效/ }).click();
    await page.getByRole('button', { name: /减少动态效果/ }).click();

    await page.reload();
    await expect(page.getByRole('heading', { name: '游戏设置' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-language'))
      )
      .toBe('zh');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-music'))
      )
      .toBe('false');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-sound'))
      )
      .toBe('false');
    await expect(page.getByTestId('game-settings-page')).toHaveClass(
      /reduce-game-motion/
    );
    expect(errors).toEqual([]);
  });

  test('shows an overall and per-mode best score summary', async ({ page }) => {
    const errors = await openHome(page);
    await page.evaluate(() => {
      localStorage.setItem('block-blast-best-score', '321');
      localStorage.setItem(
        'block-blast-score-history',
        JSON.stringify([
          { id: 'classic-321', mode: 'classic', score: 321 },
          { id: 'daily-210', mode: 'daily', score: 210 },
        ])
      );
    });
    await page.getByTestId('home-ranking').click();

    await expect(page).toHaveURL(/\/ranking$/);
    await expect(page.locator('.ranking-best-card strong')).toHaveText('321');
    await expect(
      page.locator('.mode-best-card').nth(0).locator('span')
    ).toHaveText('Classic');
    await expect(
      page.locator('.mode-best-card').nth(0).locator('strong')
    ).toHaveText('321');
    await expect(
      page.locator('.mode-best-card').nth(1).locator('span')
    ).toHaveText('Daily Challenge');
    await expect(
      page.locator('.mode-best-card').nth(1).locator('strong')
    ).toHaveText('210');
    await expect(page.locator('.standalone-score-list')).toHaveCount(0);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('serves audio assets and redirects invalid modes', async ({ page }) => {
    const errors = await openHome(page);
    for (const asset of [
      '/game/audio/gameplay-music.ogg',
      '/game/audio/block-place.mp3',
      '/game/audio/game-over.ogg',
    ]) {
      const response = await page.request.get(asset);
      expect(response.ok()).toBe(true);
    }

    await page.goto('/play/not-a-mode');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('start-classic')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('restores the settled state when refreshing during the clear animation', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await placePiece(page, 1, 0, 3);
    await placePiece(page, 2, 0, 6);
    await expect(page.getByTestId('clear-effect')).toBeVisible();
    await expect(page.getByTestId('game-score')).toHaveText('18');

    await page.reload();

    // The restored session is the settled state: the cleared line stays
    // cleared, the score is kept, and no animation replays.
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    await expect(page.getByTestId('game-score')).toHaveText('18');
    await expect(page.getByTestId('clear-effect')).toHaveCount(0);
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(0);
    await expect(page.locator('.board-cell.is-clearing')).toHaveCount(0);

    const session = await readSession(page);
    expect(session.score).toBe(18);
    expect(session.combo).toBe(1);

    // The clear sound is not replayed after the reload.
    const plays = await readAudioPlays(page);
    expect(plays.filter((src) => src.endsWith('line-clear.mp3'))).toEqual([]);

    // The board is immediately playable again.
    const move = findValidPlacement(session);
    expect(move).not.toBeNull();
    if (!move) return;
    const placedCells = session.pieces[move.pieceIndex]?.cells.length ?? 0;
    await placePiece(page, move.pieceIndex, move.row, move.column);
    await expect(page.getByTestId('game-score')).toHaveText(
      String(18 + placedCells)
    );
    expect(errors).toEqual([]);
  });

  test('keeps the board playable when leaving for settings during the clear animation', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await placePiece(page, 1, 0, 3);
    await placePiece(page, 2, 0, 6);
    await expect(page.getByTestId('clear-effect')).toBeVisible();

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByRole('button', { name: 'Go back' }).click();

    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('18');
    await expect(page.getByTestId('clear-effect')).toHaveCount(0);

    // The settlement lock is released: pieces can be placed again.
    const session = await readSession(page);
    const move = findValidPlacement(session);
    expect(move).not.toBeNull();
    if (!move) return;
    const placedCells = session.pieces[move.pieceIndex]?.cells.length ?? 0;
    await expect(
      page.getByTestId(`game-piece-${move.pieceIndex}`)
    ).toBeEnabled();
    await placePiece(page, move.pieceIndex, move.row, move.column);
    await expect(page.getByTestId('game-score')).toHaveText(
      String(18 + placedCells)
    );
    expect(errors).toEqual([]);
  });

  test('settles consecutive clears exactly once and plays the combo sound with the clear', async ({
    page,
  }) => {
    const errors = await openHome(page);
    const board = createEmptyBoard();
    // Row 0 is one cell short of a clear, row 1 is two cells short.
    for (let column = 1; column < BOARD_SIZE; column += 1) {
      board[0][column] = 'red';
    }
    for (let column = 2; column < BOARD_SIZE; column += 1) {
      board[1][column] = 'blue';
    }
    await injectSession(
      page,
      createCraftedSession({
        board,
        pieces: [
          {
            color: 'red',
            cells: [[0, 0]],
            id: 'crafted-single',
            key: 'single',
          },
          {
            color: 'blue',
            cells: [
              [0, 0],
              [0, 1],
            ],
            id: 'crafted-line',
            key: 'line-2-h',
          },
          null,
        ],
        score: 100,
      })
    );
    await page.goto('/play/classic');
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    await expect(page.getByTestId('game-score')).toHaveText('100');

    // First clear: 1 placement point + 10 clear points at combo level 1.
    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('clear-effect')).toBeVisible();
    await expect(page.getByTestId('game-score')).toHaveText('111');
    await expect(page.getByTestId('clear-effect')).toHaveCount(0);
    await expect(page.getByTestId('game-score')).toHaveText('111');

    // Second consecutive clear: 2 placement points + 10 clear points
    // doubled by combo level 2.
    await placePiece(page, 1, 1, 0);
    await expect(page.getByTestId('clear-effect')).toBeVisible();
    await expect(page.getByTestId('game-score')).toHaveText('133');
    await expect(page.getByTestId('clear-effect')).toHaveCount(0);
    await expect(page.getByTestId('game-score')).toHaveText('133');

    const plays = await readAudioPlays(page);
    expect(plays.filter((src) => src.endsWith('line-clear.mp3'))).toHaveLength(
      2
    );
    expect(plays.filter((src) => src.endsWith('combo-2.mp3'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('restores a settled game over when refreshing during the clear animation', async ({
    page,
  }) => {
    const errors = await openHome(page);
    // Row 0 is empty only at (0,0), and a scattered set of holes keeps every
    // other row and column incomplete. Placing the single block completes
    // row 0; afterwards no 4-cell vertical run of empty cells exists, so
    // the remaining vertical pieces cannot fit and the move ends the game.
    const board = createEmptyBoard();
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let column = 0; column < BOARD_SIZE; column += 1) {
        board[row][column] = (row + column) % 2 === 0 ? 'red' : 'blue';
      }
    }
    board[0][0] = null;
    const holes: Array<[number, number]> = [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 5],
      [7, 6],
      [1, 7],
    ];
    for (const [row, column] of holes) {
      board[row][column] = null;
    }
    await injectSession(
      page,
      createCraftedSession({
        board,
        pieces: [
          {
            color: 'red',
            cells: [[0, 0]],
            id: 'crafted-single',
            key: 'single',
          },
          {
            color: 'blue',
            cells: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
              [4, 0],
            ],
            id: 'crafted-line-5v',
            key: 'line-5-v',
          },
          {
            color: 'green',
            cells: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
            ],
            id: 'crafted-line-4v',
            key: 'line-4-v',
          },
        ],
        score: 50,
      })
    );
    await page.goto('/play/classic');
    await expect(page.getByTestId('game-score')).toHaveText('50');

    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('clear-effect')).toBeVisible();

    await page.reload();

    // The game-over settlement was part of the move, so the restored
    // session shows the result directly instead of a dead board.
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    await expect(page.getByTestId('game-score')).toHaveText('61');
    await expect(page.getByRole('dialog')).toBeVisible();
    const session = await readSession(page);
    expect(session.gameOver).toBe(true);

    // The game-over sound is not replayed after the reload.
    const plays = await readAudioPlays(page);
    expect(plays.filter((src) => src.endsWith('game-over.ogg'))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('produces no audio playback while sound and music are disabled', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-settings').click();
    await page.getByRole('button', { name: /Background music/ }).click();
    await page.getByRole('button', { name: /Sound effects/ }).click();
    await page.getByRole('button', { name: 'Go back' }).click();

    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await placePiece(page, 1, 0, 3);
    await placePiece(page, 2, 0, 6);
    await expect(page.getByTestId('clear-effect')).toBeVisible();
    await expect(page.getByTestId('game-score')).toHaveText('18');

    expect(await readAudioPlays(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
