var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var analyser = audioCtx.createAnalyser();
analyser.fftSize = 256; // 256 for analyser.getByteFrequencyData(dataArray) and 2048 for analyser.getByteTimeDomainData(dataArray)
var dataArray = new Uint8Array(analyser.frequencyBinCount);
var source = null;
var gui;
var resizeVisualizer;
var defaultSong = "https://firebasestorage.googleapis.com/v0/b/kantelabs-threejs.appspot.com/o/03%20-%20Smooth%20Operator.mp3?alt=media&token=27e95f4c-b4fb-4160-9bdc-02833cf65a84";

window.onload = function () {
    var fileUpload = document.querySelector('#audioFile'); //Grabs the file input and stores it in an variable
    var prevSongs = document.querySelector('#prevSongs');
    var songSearch = document.querySelector('#song-search');
    var clearSongSearch = document.querySelector('#clear-song-search');
    var noMatchingSongs = document.querySelector('#no-matching-songs');
    var trackTitle = document.querySelector('#track-title');
    var library = document.querySelector('#past-songs');
    var libraryToggle = document.querySelector('#library-toggle');
    var settings = document.querySelector('#camera-settings');
    var settingsToggle = document.querySelector('#settings-toggle');
    var narrowLayout = window.matchMedia('(max-width: 700px)');
    var selectedSong;
    var currentSongUrl = defaultSong;
    var searchQuery = '';

    // Playback state. Exactly one audio element, one analyser source and one
    // render loop exist for the lifetime of the page; switching a track only
    // re-points them at the new media instead of building the whole pipeline
    // again.
    var audioPlayer;
    var currentObjectUrl = null;
    var renderLoopId = null;
    var animateFrame = null;
    var trackSwitchId = 0;
    var pendingUpload = null;
    var renderer;
    var scene;
    var camera;
    var controls;
    var cubeMaterial;
    var asteroidMaterial;

    function getSongFilename(url) {
        try {
            return decodeURIComponent(new URL(url, document.baseURI).pathname).split('/').pop();
        } catch {
            return '';
        }
    }

    function updateSearchResults() {
        var hasNoMatches = searchQuery !== '' && !prevSongs.querySelector('li:not([hidden])');
        noMatchingSongs.hidden = !hasNoMatches;
        prevSongs.hidden = hasNoMatches;
    }

    function filterSongs() {
        searchQuery = songSearch.value.trim().toLowerCase();
        for (const item of prevSongs.children) {
            item.hidden = !item.dataset.searchText.includes(searchQuery);
        }
        clearSongSearch.hidden = songSearch.value === '';
        prevSongs.scrollTop = 0;
        updateSearchResults();
    }

    function setLibraryOpen(open) {
        if (open && narrowLayout.matches) {
            setSettingsOpen(false);
            library.showModal();
        } else if (open) {
            library.show();
        } else {
            library.close();
        }
        libraryToggle.hidden = library.open;
        libraryToggle.setAttribute('aria-expanded', String(library.open));
    }

    function closeLibrary() {
        setLibraryOpen(false);
        libraryToggle.focus();
    }

    function setSettingsOpen(open) {
        if (open && narrowLayout.matches && library.open) setLibraryOpen(false);
        settings.hidden = !open;
        settingsToggle.setAttribute('aria-expanded', String(open));
    }

    function syncLibraryLayout() {
        setLibraryOpen(false);
        if (!narrowLayout.matches) setLibraryOpen(true);
    }

    syncLibraryLayout();
    narrowLayout.addEventListener('change', syncLibraryLayout);
    libraryToggle.addEventListener('click', () => setLibraryOpen(true));
    document.querySelector('#library-close').addEventListener('click', closeLibrary);
    document.querySelector('#add-music').addEventListener('click', () => fileUpload.click());
    songSearch.addEventListener('input', filterSongs);
    songSearch.addEventListener('keydown', (event) => {
        if (event.key.startsWith('Arrow')) event.stopPropagation();
    });
    clearSongSearch.addEventListener('click', () => {
        songSearch.value = '';
        filterSongs();
        songSearch.focus();
    });
    library.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeLibrary();
    });
    library.addEventListener('click', (event) => {
        if (!narrowLayout.matches || event.target !== library) return;
        var bounds = library.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX >= bounds.right ||
            event.clientY < bounds.top || event.clientY >= bounds.bottom) {
            closeLibrary();
        }
    });
    settingsToggle.addEventListener('click', () => setSettingsOpen(settings.hidden));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !settings.hidden) {
            setSettingsOpen(false);
            settingsToggle.focus();
        }
    });

    // Audio pipeline. The source node is created once for the single audio
    // element; track changes disconnect it, swap the media and reconnect it.
    var audioDiv = document.querySelector('.audio-container');
    audioPlayer = new Audio(defaultSong);
    audioPlayer.crossOrigin = "anonymous";
    audioPlayer.controls = true;
    audioDiv.replaceChildren(audioPlayer);
    audioPlayer.addEventListener('play', () => audioCtx.resume());
    for (const event of ['playing', 'pause', 'ended', 'emptied', 'waiting', 'seeked', 'error']) {
        audioPlayer.addEventListener(event, updatePlayingIndicator);
    }

    source = audioCtx.createMediaElementSource(audioPlayer); // Uploaded audio becomes the source for the media stream
    source.connect(analyser);
    analyser.connect(audioCtx.destination);

    unlockAudioContext(audioCtx);

    setupVisualizer();

    if (window.ResizeObserver) {
        new ResizeObserver(() => resizeVisualizer()).observe(document.body);
    } else {
        window.addEventListener('resize', () => resizeVisualizer());
    }

    // Release any local file still backing the player when the page is really
    // going away. Skip bfcache entries: the blob URL is still needed if the
    // user navigates back.
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) return;
        cancelPendingUpload();
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
    });

    //Searches for and loads previous songs uploaded to firebase
    var storageRef = null;
    var songsRef = null;
    try {
        if (window.firebase && typeof window.firebase.storage === 'function' &&
            typeof window.firebase.database === 'function') {
            storageRef = window.firebase.storage().ref();
            songsRef = window.firebase.database().ref().child('songs');
        }
    } catch (err) {
        console.warn('Firebase unavailable', err);
    }

    if (songsRef) {
        songsRef.on('child_added', snapshot => {
            const songUrl = snapshot.val();
            const item = document.createElement('li');
            const button = document.createElement('button');
            item.dataset.searchText = (snapshot.key + '\n' + getSongFilename(songUrl)).toLowerCase();
            item.hidden = !item.dataset.searchText.includes(searchQuery);
            button.type = 'button';
            button.textContent = button.title = snapshot.key;
            button.addEventListener('click', () => {
                beginTrackSwitch();
                var wasPlaying = !audioPlayer.paused && !audioPlayer.ended && !audioPlayer.error;
                activateTrack(snapshot.key, songUrl, button, null);
                if (wasPlaying) resumePlayback();
                if (narrowLayout.matches) closeLibrary();
            });
            item.appendChild(button);
            prevSongs.appendChild(item);
            if (searchQuery) updateSearchResults();
            if (songUrl === currentSongUrl && !selectedSong) {
                selectSong(button);
            }
        });
    }

    function updatePlayingIndicator() {
        if (!selectedSong) return;
        const playing = !audioPlayer.paused && !audioPlayer.ended && !audioPlayer.error &&
            audioPlayer.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        selectedSong.toggleAttribute('data-playing', playing);
        if (playing) {
            selectedSong.setAttribute('aria-description', 'Playing');
        } else {
            selectedSong.removeAttribute('aria-description');
        }
    }

    function selectSong(button) {
        if (selectedSong) {
            selectedSong.removeAttribute('aria-current');
            selectedSong.removeAttribute('data-playing');
            selectedSong.removeAttribute('aria-description');
        }
        selectedSong = button;
        if (selectedSong) {
            selectedSong.setAttribute('aria-current', 'true');
            updatePlayingIndicator();
        }
    }

    function setCurrentTrack(name, url, button) {
        trackTitle.textContent = trackTitle.title = name;
        currentSongUrl = url;
        selectSong(button);
    }

    // Swapping src on a playing element kept the new track playing; reproduce
    // that so the transport and the playing indicator stay in step. The
    // promise may reject (autoplay policy / unreadable source), so settle the
    // indicator instead of leaving an unhandled rejection behind.
    function resumePlayback() {
        var result;
        try {
            result = audioPlayer.play();
        } catch (err) {
            updatePlayingIndicator();
            return;
        }
        if (result && typeof result.catch === 'function') {
            result.catch(() => updatePlayingIndicator());
        }
    }

    // Starts a new switch generation. Any upload that is still being validated
    // belongs to an older generation and must not take over the player.
    function beginTrackSwitch() {
        trackSwitchId += 1;
        cancelPendingUpload();
        return trackSwitchId;
    }

    function cancelPendingUpload() {
        var pending = pendingUpload;
        if (!pending) return;
        pendingUpload = null;
        pending.cancel();
    }

    // A new song gets its own palette, as the scene used to provide by
    // being rebuilt. Recoloring keeps the same geometry and camera state.
    function recolorScene() {
        if (cubeMaterial) cubeMaterial.color.setHex(Math.random() * 0xffffff);
        if (asteroidMaterial) asteroidMaterial.color.setHex(Math.random() * 0xffffff);
    }

    // Tear down the previous track and point the single audio source at the
    // new one. The old animation loop is stopped first, the old source node is
    // disconnected, any local object URL is released, and only then is the new
    // media loaded and the loop restarted.
    function activateTrack(name, url, button, objectUrl) {
        stopRenderLoop();

        audioPlayer.pause();
        try {
            audioPlayer.removeAttribute('src');
            audioPlayer.load();
        } catch (err) { /* the element may already be empty */ }

        if (source) {
            try {
                source.disconnect();
            } catch (err) { /* already disconnected */ }
        }

        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        currentObjectUrl = objectUrl;

        audioPlayer.src = url;
        audioPlayer.load();
        if (source) source.connect(analyser);

        recolorScene();

        setCurrentTrack(name, url, button);
        startRenderLoop();
        updatePlayingIndicator();
    }

    fileUpload.addEventListener('change', (event) => {
        var file = event.target.files && event.target.files[0];
        // Reset so picking the same file again still fires a change event.
        fileUpload.value = '';
        if (!file) {
            // A cancelled file dialog must leave the current track untouched.
            return;
        }
        startUpload(file);
    });

    // The "cancel" event fires when the file picker is dismissed without a
    // selection; it must not disturb whatever is already playing.
    fileUpload.addEventListener('cancel', () => {
        fileUpload.value = '';
    });

    function startUpload(file) {
        var switchId = beginTrackSwitch();
        var objectUrl = URL.createObjectURL(file);
        var probe = new Audio();
        var settled = false;
        var timer = null;

        var pending = {
            cancel: function () {
                finish(false);
            }
        };
        pendingUpload = pending;

        function finish(valid) {
            if (settled) return;
            settled = true;
            if (pendingUpload === pending) pendingUpload = null;
            clearTimeout(timer);
            probe.removeEventListener('loadedmetadata', onLoaded);
            probe.removeEventListener('error', onError);
            try {
                probe.removeAttribute('src');
                probe.load();
            } catch (err) { /* released below in every branch */ }

            // Superseded by another switch, invalid audio, or a cancelled
            // selection: discard the probe URL and keep whatever is playing.
            if (!valid || switchId !== trackSwitchId) {
                URL.revokeObjectURL(objectUrl);
                return;
            }

            activateTrack(file.name, objectUrl, null, objectUrl);
            uploadToLibrary(file, file.name);
            if (narrowLayout.matches) closeLibrary();
        }

        function onLoaded() {
            finish(true);
        }

        function onError() {
            finish(false);
        }

        // Validate the local file before touching the live player so an unreadable
        // or invalid file can never interrupt the track that is currently playing.
        probe.preload = 'metadata';
        probe.addEventListener('loadedmetadata', onLoaded);
        probe.addEventListener('error', onError);
        timer = setTimeout(() => finish(false), 10000);
        probe.src = objectUrl;
        probe.load();
    }

    function uploadToLibrary(file, songName) {
        if (!storageRef) return;
        try {
            storageRef.child(songName).put(file).then(function (snapshot) {
                var dlUrl = snapshot.downloadURL;
                if (!dlUrl) return;
                return window.firebase.database().ref().child('songs')
                    .child(songName.split('.').slice(0, 1).join(' ')).set(dlUrl);
            }).catch(function (err) {
                // A failed remote upload must not affect local playback.
                console.log(err);
            });
        } catch (err) {
            console.log(err);
        }
    }

    function setupVisualizer() {
        //Scene Details
        scene = new THREE.Scene(); //new scene instance
        scene.background = new THREE.Color(0x000000);
        scene.fog = new THREE.FogExp2(0xcccccc, 0.002);

        renderer = new THREE.WebGLRenderer();
        document.body.appendChild(renderer.domElement);

        //Lighting Details
        var light = new THREE.AmbientLight(0x505050);
        scene.add(light);
        var directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(0, 1, 1);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(1, 1, 0);
        scene.add(directionalLight);


        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(0, -1, -1);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(-1, -1, 0);
        scene.add(directionalLight);

        //Camera Details
        camera = new THREE.PerspectiveCamera(65, 1, 1, 1000);
        camera.position.x = 32;
        camera.position.y = 50;
        camera.position.z = 50;
        camera.lookAt(scene.position);

        resizeVisualizer = function () {
            var width = document.body.clientWidth;
            var height = document.body.clientHeight;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height, false);
        };
        resizeVisualizer();

        //Controls Details
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.autoRotate = false;

        if (gui) gui.destroy();
        gui = new dat.GUI({ autoPlace: false, width: 262 });
        document.querySelector('#camera-settings').replaceChildren(gui.domElement);

        var f1 = gui.addFolder('Camera')
        f1.add(controls, 'autoRotate', false, true)
        f1.add(controls, 'autoRotateSpeed', 0, 10).step(0.5)
        f1.add(camera.position, 'x', -500, 500).step(5)
        f1.add(camera.position, 'y', -500, 500).step(5)
        f1.add(camera.position, 'z', -500, 500).step(5)
        f1.open()


        //Cubes Details
        var cubes = new Array();
        var cubeGeometry = new THREE.CubeGeometry(1.5, 1.5, 1.5)
        cubeMaterial = new THREE.MeshPhongMaterial({
            color: (Math.random() * 0xffffff),
            flatShading: false,
            specular: 0xffffff,
            shininess: 14,
            reflectivity: 2,
            fog: false
        });

        var i = 0;
        for (var x = 0; x <= 256; x += 2) {
            var j = 0;
            cubes[i] = new Array();
            for (var y = 0; y <= 62; y += 2) {
                cubes[i][j] = new THREE.Mesh(cubeGeometry, cubeMaterial);
                cubes[i][j].position.x = (y - 30);
                cubes[i][j].position.y = (0);
                cubes[i][j].position.z = (x);
                scene.add(cubes[i][j])
                j++;
            }
            i++;
        }

        //BackgroundShapes Details
        var asteroidMesh = new Array()
        var asteroidGeometry = new THREE.TetrahedronGeometry((Math.random() + 0.5), 2);
        asteroidMaterial = new THREE.MeshPhongMaterial({
            color: (Math.random() * 0xffffff),
            flatShading: true
        });

        var i = 0;
        for (var x = 0; x < 1; x++) {
            var j = 0;
            asteroidMesh[i] = new Array();
            for (var y = 0; y < 1000; y++) {
                asteroidMesh[i][j] = new THREE.Mesh(asteroidGeometry, asteroidMaterial);
                asteroidMesh[i][j].position.x = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].position.y = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].position.z = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].scale.z = (Math.random() * 2, Math.random() * 2, Math.random() * 2);
                asteroidMesh[i][j].rotation.set(Math.random() * 4, Math.random() * 4, Math.random() * 4)
                scene.add(asteroidMesh[x][j])
                j++;
            }
            i++;
        }

        animateFrame = function animate() {
            renderLoopId = requestAnimationFrame(animateFrame) //better than set interval because it pauses when user leaves the page
            analyser.getByteFrequencyData(dataArray)
            controls.update();

            var k = 0;
            for (var i = 0; i < cubes.length; i++) {
                for (var j = 0; j < cubes[i].length; j++) {
                    var scale = dataArray[k] / 10;
                    cubes[i][j].scale.y = (scale < 1 ? 1 : scale);
                    k += (k < dataArray.length ? 1 : 0);
                }
            }

            var k = 0;
            for (var i = 0; i < asteroidMesh.length; i++) {
                for (var j = 0; j < asteroidMesh[i].length; j++) {
                    asteroidMesh[i][j].rotation.z += 0.02;
                }
            }
            renderer.render(scene, camera)
        }

        startRenderLoop();
    }

    function startRenderLoop() {
        if (renderLoopId !== null) return; // never run two loops at once
        animateFrame(); //gets called 60x per sec to render scene
    }

    function stopRenderLoop() {
        if (renderLoopId === null) return;
        cancelAnimationFrame(renderLoopId);
        renderLoopId = null;
    }
}

function unlockAudioContext(audioCtx) {
    if (audioCtx.state !== 'suspended') return;
    const b = document.body;
    const events = ['touchstart', 'touchend', 'mousedown', 'keydown'];
    events.forEach(e => b.addEventListener(e, unlock, false));
    function unlock() { audioCtx.resume() }
    function clean() { events.forEach(e => b.removeEventListener(e, unlock)); }
}
