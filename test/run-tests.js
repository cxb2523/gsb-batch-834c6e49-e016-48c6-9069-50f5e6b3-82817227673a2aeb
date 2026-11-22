'use strict';

/**
 * Офлайн-тесты инвариантов «единой сессии воспроизведения».
 * Запуск: node test/run-tests.js   (без сети и внешних зависимостей)
 *
 * Сценарии:
 *  1. Замена iframe плеера — старая сессия освобождена, новая подключена
 *     с сохранёнными громкостью/скоростью, heartbeat только один.
 *  2. Ручная пауза → смена серии — внутри сессии плеер не может сам
 *     сняться с паузы, но новая серия/плеер автозапускается.
 *  3. Переключение heartbeat — только текущая сессия/серия/anime id,
 *     старое видео не шлёт своё время в новую серию, нет двух таймеров.
 *  4. Полный экран и уход со страницы — панель/модалка мигрируют в видимый
 *     документ, кнопки действуют на текущую сессию, pagehide всё останавливает.
 */

const { createWorld, step, flush, FakeEvent } = require('./harness');

let failures = 0;
let checks = 0;

function assert(cond, msg) {
    checks++;
    if (!cond) {
        failures++;
        console.error(`  ✗ ${msg}`);
    } else {
        console.log(`  ✓ ${msg}`);
    }
}

function lastHeartbeat(world) {
    const calls = world.heartbeatCalls();
    return calls.length ? calls[calls.length - 1].body : null;
}

// ---------- Сценарий 1: замена iframe плеера ----------
async function scenarioIframeReplace() {
    console.log('\n[1] Замена iframe плеера');
    const world = createWorld({
        href: 'https://senku.one/watch/123?episode=1&season=1',
        storage: { senku_autonext_volume: '0.5', senku_autonext_speed: '1.5' },
    }).loadScript();

    const { iframe: iframe1, video: video1 } = world.addPlayer(1);
    video1.currentTime = 30;
    await step(world, 2, video1);

    const s1 = world.session();
    assert(s1 && s1.video === video1, 'сессия создана и привязана к video1');
    assert(video1.volume === 0.5 && video1.muted === false, 'к video1 применена сохранённая громкость 0.5');
    assert(video1.playbackRate === 1.5, 'к video1 применена сохранённая скорость 1.5');
    assert(video1.paused === false, 'video1 автозапущен');
    const hb1 = lastHeartbeat(world);
    assert(hb1 && hb1.anime_id === '123' && hb1.episode === 1 && hb1.duration === 200,
        `heartbeat идёт для ep1 (time=${hb1 && hb1.time})`);
    assert(world.heartbeatTimerCount() === 1, 'ровно один heartbeat-таймер');
    assert(video1.listenerCount() > 0, 'на video1 висят слушатели сессии');

    // Плеер заменили новым iframe (та же серия)
    world.removePlayer(iframe1);
    const { video: video2 } = world.addPlayer(1);
    video2.currentTime = 5;
    await step(world, 2, video2);

    const s2 = world.session();
    assert(s1.disposed === true, 'старая сессия помечена disposed');
    assert(s1.heartbeatTimer === null, 'heartbeat старой сессии остановлен');
    assert(video1.listenerCount() === 0, 'слушатели сняты со старого video1');
    assert(s2 && s2 !== s1 && s2.video === video2, 'создана новая сессия для video2');
    assert(video2.volume === 0.5, 'к video2 применена сохранённая громкость');
    assert(video2.playbackRate === 1.5, 'к video2 применена сохранённая скорость');
    assert(video2.playCount >= 1 && video2.paused === false, 'video2 автозапущен (ручной паузы не было)');
    assert(world.heartbeatTimerCount() === 1, 'после замены всё ещё ровно один heartbeat-таймер');
    const hb2 = lastHeartbeat(world);
    assert(hb2 && hb2.episode === 1 && hb2.time === Math.floor(video2.currentTime),
        `heartbeat шлёт время нового видео (time=${hb2 && hb2.time})`);
    const stale = world.heartbeatCalls().filter(c => c.body.time >= 30 && c.body.time <= 33);
    assert(stale.length <= 1, 'старый таймер не продолжает слать время video1 после замены');
}

// ---------- Сценарий 2: ручная пауза → смена серии ----------
async function scenarioManualPauseThenEpisode() {
    console.log('\n[2] Ручная пауза, затем смена серии');
    const world = createWorld({ href: 'https://senku.one/watch/123?episode=1&season=1' }).loadScript();

    const { iframe: iframe1, video: video1 } = world.addPlayer(1);
    video1.currentTime = 30;
    await step(world, 2, video1);
    const s1 = world.session();
    assert(s1 && video1.paused === false, 'ep1 играет');

    // Пользователь жмёт паузу на панели
    const pauseBtn = world.document.querySelector('.senku-pause-btn');
    assert(!!pauseBtn, 'кнопка паузы на панели найдена');
    pauseBtn.dispatchEvent(new FakeEvent('click'));
    assert(s1.manualPause === true, 'manualPause выставлен в сессии');
    assert(video1.paused === true, 'video1 на паузе');

    await step(world, 2, video1); // проходит 2 с (> окна пользовательского действия)

    // Плеер пытается сам возобновиться внутри той же сессии
    video1.paused = false;
    video1.emit('play');
    assert(video1.paused === true, 'самовозобновление плеера заблокировано внутри сессии');
    assert(s1.manualPause === true, 'manualPause не сброшен самовозобновлением');

    // Смена серии: сайт заменил плеер на ep2
    world.removePlayer(iframe1);
    const { video: video2 } = world.addPlayer(2);
    video2.currentTime = 1;
    await step(world, 2, video2);

    const s2 = world.session();
    assert(s2 && s2 !== s1 && s2.episode === 2, 'создана новая сессия для ep2');
    assert(s2.manualPause === false, 'ручная пауза прошлой серии не действует на новую');
    assert(s2.wantPlaying === true, 'новая сессия хочет играть');
    assert(video2.playCount >= 1 && video2.paused === false, 'ep2 автозапущен несмотря на паузу в ep1');
}

// ---------- Сценарий 3: переключение heartbeat ----------
async function scenarioHeartbeatSwitch() {
    console.log('\n[3] Переключение heartbeat между сериями');
    const world = createWorld({ href: 'https://senku.one/watch/123?episode=1&season=1' }).loadScript();

    const { iframe: iframe1, video: video1 } = world.addPlayer(1);
    video1.currentTime = 40;
    await step(world, 2, video1);
    assert(world.heartbeatTimerCount() === 1, 'heartbeat ep1 запущен');

    video1.currentTime = 40;
    await step(world, 15, video1); // один тик heartbeat (15 с)
    const beatsEp1 = world.heartbeatCalls();
    assert(beatsEp1.every(c => c.body.episode === 1 && c.body.anime_id === '123'),
        'все heartbeat до смены — только ep1 / anime 123');
    assert(beatsEp1.length >= 2, `heartbeat тикает по интервалу (отправлено ${beatsEp1.length})`);

    // Смена серии на ep2
    world.removePlayer(iframe1);
    const { video: video2 } = world.addPlayer(2);
    video2.currentTime = 7;
    await step(world, 2, video2);
    assert(world.heartbeatTimerCount() === 1, 'после смены серии ровно один heartbeat-таймер');

    const mark = world.heartbeatCalls().length;
    video2.currentTime = 20;
    await step(world, 15, video2); // тики heartbeat уже для ep2

    const beatsEp2 = world.heartbeatCalls().slice(mark);
    assert(beatsEp2.length >= 1, 'heartbeat продолжает тикать для ep2');
    assert(beatsEp2.every(c => c.body.episode === 2 && c.body.anime_id === '123'),
        'после смены heartbeat идёт только для ep2');
    assert(beatsEp2.every(c => c.body.time < 40),
        'время старого видео (>= 40) не уходит в новую серию');
    assert(world.heartbeatTimerCount() === 1, 'параллельных heartbeat-таймеров нет');

    // Уход со страницы /watch: heartbeat и таймеры останавливаются
    world.navigateTo('https://senku.one/anime/123');
    await step(world, 2, video2);
    assert(world.session() === null, 'сессия уничтожена при уходе со /watch');
    assert(world.heartbeatTimerCount() === 0, 'heartbeat-таймер остановлен вне /watch');
    const mark2 = world.heartbeatCalls().length;
    await step(world, 30, video2);
    assert(world.heartbeatCalls().length === mark2, 'вне /watch heartbeat не отправляется');
}

// ---------- Сценарий 4: полный экран и выгрузка страницы ----------
async function scenarioFullscreenAndUnload() {
    console.log('\n[4] Полный экран и остановка при выгрузке');
    const world = createWorld({ href: 'https://senku.one/watch/123?episode=1&season=1' }).loadScript();

    const { iframe: iframe1, video: video1 } = world.addPlayer(1);
    video1.currentTime = 30;
    await step(world, 2, video1);
    const s1 = world.session();

    const panel = world.document.querySelector('#senku-autonext-panel');
    const queueModal = world.document.querySelector('#senku-queue-modal');
    assert(panel && panel.parentNode === world.document.body, 'панель изначально на body страницы');

    // Вход в полный экран на iframe плеера
    world.document.fullscreenElement = iframe1;
    world.document.emit('fullscreenchange');
    const innerBody = iframe1.contentDocument.body;
    assert(panel.parentNode === innerBody, 'панель переехала в документ полноэкранного iframe');
    assert(queueModal.parentNode === innerBody, 'модалка очереди переехала туда же');

    // Кнопки панели по-прежнему управляют текущей сессией
    // (ищем кнопку внутри панели — она уже живёт в документе полноэкранного iframe)
    const pauseBtn = panel.querySelector('.senku-pause-btn');
    assert(!!pauseBtn, 'кнопка паузы доступна внутри переехавшей панели');
    pauseBtn.dispatchEvent(new FakeEvent('click'));
    assert(video1.paused === true && s1.manualPause === true,
        'кнопка паузы из полноэкранного документа ставит текущее видео на паузу');

    // Выход из полного экрана
    world.document.fullscreenElement = null;
    world.document.emit('fullscreenchange');
    assert(panel.parentNode === world.document.body, 'панель вернулась на body страницы');
    assert(queueModal.parentNode === world.document.body, 'модалка вернулась на body страницы');

    // Снимаем паузу и убеждаемся, что heartbeat снова идёт
    pauseBtn.dispatchEvent(new FakeEvent('click'));
    await flush();
    assert(video1.paused === false, 'воспроизведение возобновлено кнопкой');
    await step(world, 1, video1);
    assert(world.heartbeatTimerCount() === 1, 'heartbeat снова тикает');

    // Выгрузка страницы: heartbeat и таймеры сессии останавливаются
    world.emitWindow('pagehide');
    assert(world.session() === null, 'сессия уничтожена на pagehide');
    assert(world.heartbeatTimerCount() === 0, 'heartbeat остановлен на pagehide');
}

(async () => {
    try {
        await scenarioIframeReplace();
        await scenarioManualPauseThenEpisode();
        await scenarioHeartbeatSwitch();
        await scenarioFullscreenAndUnload();
    } catch (e) {
        failures++;
        console.error('\n💥 Тест упал с исключением:', e);
    }
    console.log(`\n${checks - failures}/${checks} проверок пройдено`);
    if (failures > 0) {
        console.error('❌ ЕСТЬ ПРОВАЛЫ');
        process.exit(1);
    }
    console.log('✅ Все сценарии зелёные');
})();
