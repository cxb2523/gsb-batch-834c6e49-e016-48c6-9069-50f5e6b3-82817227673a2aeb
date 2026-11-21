"""Server-side guarantees behind the browser edit-history chain.

These tests pin the two server contracts the new client history/save modules
depend on, without any browser or network beyond an in-process loopback:

  * revision is an optimistic-lock baseline: an MCP/other-client write moves
    the revision, and any save carrying the old revision is rejected with 409
    so a stale local snapshot can never overwrite the new project;
  * the export policy is unchanged — an unbound template blocks export while
    visible, and merely hiding it makes the export succeed (the object is
    skipped, never silently exported with a guessed template).

Coordinate conversion and the static GIA encoder are exercised by the
existing test_static_export.py / test_core.py suites and are not touched here.
"""
import copy
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.catalog import Catalog
from core.generator import node
from core.gia import ExportBlocked, export_scene
from core.scene import ProjectStore, empty, flatten
from server import App, Handler

CAT = Catalog()
TEST_TMP = ROOT / '.runtime/tests'
TEST_TMP.mkdir(parents=True, exist_ok=True)


def catalog_with_unbound():
    """Real catalog plus one deterministic template-less (unbound) asset."""
    catalog = copy.copy(CAT)
    catalog.assets = [copy.deepcopy(a) for a in CAT.assets]
    unbound = dict(
        id='terrain-local-unbound', name='本地未绑定地块', category='地块',
        internalName='terrain_local_unbound', aliases=[], templateId=None,
        tags=['地块'], dimensions=[4, 1, 4], triangles=0, modelUrl=None,
        glb=None, warnings=[], primitive=None,
    )
    catalog.assets.append(unbound)
    catalog.by_id = {a['id']: a for a in catalog.assets}
    catalog.by_template = {}
    for asset in catalog.assets:
        if asset['templateId']:
            catalog.by_template.setdefault(asset['templateId'], asset)
    return catalog


class RevisionBaselineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=TEST_TMP)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.store = ProjectStore(self.root / 'projects', CAT)

    def test_mcp_write_advances_revision_and_stale_local_save_is_rejected(self):
        # The browser editor starts from revision 0 and makes one local edit.
        local = empty('本地布局'); local['nodes'] = [node('10009001', '本地基元')]
        ack = self.store.put(local, 0, source='web')
        self.assertEqual(ack['revision'], 1)

        # An MCP client read revision 1 and replaces the whole project.
        mcp_scene = empty('MCP 改写后的工程')
        mcp_ack = self.store.put(mcp_scene, 1, source='mcp')
        self.assertEqual(mcp_ack['revision'], 2)
        self.assertEqual(self.store.get()['source'], 'mcp')

        # The editor's undo then tries to write its pre-MCP snapshot with the
        # revision it still remembers (1). The server must refuse it.
        stale = empty('本地撤销产生的旧快照')
        with self.assertRaisesRegex(RuntimeError, '工程已被另一端更新'):
            self.store.put(stale, 1, source='web')

        # The refused write must leave the MCP project completely intact.
        current = self.store.get()
        self.assertEqual(current['revision'], 2)
        self.assertEqual(current['project']['name'], 'MCP 改写后的工程')

        # After adopting the new baseline, continued edits save normally.
        continued = empty('在新基线上继续编辑')
        next_ack = self.store.put(continued, 2, source='web')
        self.assertEqual(next_ack['revision'], 3)
        self.assertEqual(self.store.get()['project']['name'], '在新基线上继续编辑')

    def test_revision_conflict_surfaces_as_http_409_with_conflict_flag(self):
        app = object.__new__(App)
        app.catalog = CAT
        app.store = self.store
        app.provider = None
        app.exports = self.root / 'exports'
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.app = app
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        url = f'http://127.0.0.1:{server.server_port}/api/project'

        def post(payload):
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'X-XingGou': '1'})
            return opener.open(req, timeout=15)

        try:
            with post(dict(project=empty('A'), revision=0, source='web')) as r:
                self.assertEqual(json.load(r)['revision'], 1)
            # Another writer wins revision 1 first.
            self.store.put(empty('B'), 1, source='mcp')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                post(dict(project=empty('stale'), revision=1, source='web'))
            self.assertEqual(caught.exception.code, 409)
            body = json.load(caught.exception)
            self.assertTrue(body['conflict'])
            self.assertIn('另一端', body['error'])
        finally:
            server.shutdown()
            server.server_close()


class UnboundExportPolicyTests(unittest.TestCase):
    def setUp(self):
        self.catalog = catalog_with_unbound()
        self.tmp = tempfile.TemporaryDirectory(dir=TEST_TMP)
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / 'exports'

    def _scene(self, unbound_visible):
        scene = empty('未绑定导出策略')
        scene['nodes'] = [
            node('10009001', '已绑定基元', (0, 0, 0)),
            node('terrain-local-unbound', '未绑定地块', (3, 0, 0)),
        ]
        scene['nodes'][1]['visible'] = unbound_visible
        return scene

    def test_visible_unbound_object_blocks_export_with_existing_error_shape(self):
        scene = self._scene(unbound_visible=True)
        objects, blocked = flatten(scene, self.catalog)
        self.assertTrue(blocked, 'visible template-less objects must block export')
        self.assertEqual(blocked[0]['assetId'], 'terrain-local-unbound')
        with self.assertRaises(ExportBlocked) as caught:
            export_scene(scene, self.catalog, self.out)
        self.assertEqual(caught.exception.blocked[0]['name'], '未绑定地块')

    def test_hidden_unbound_object_is_skipped_and_export_still_succeeds(self):
        scene = self._scene(unbound_visible=False)
        objects, blocked = flatten(scene, self.catalog)
        self.assertFalse(blocked, 'hiding an unbound object must remove the block')
        self.assertEqual(len(objects), 1, 'only the visible bound object is exported')
        self.assertEqual(objects[0]['asset_id'], '10009001')
        result = export_scene(scene, self.catalog, self.out)
        report = result['report']
        # Static-export semantics stay exactly as before: independent static
        # entities, no dynamic parent, one entity for the one visible object.
        self.assertEqual(report['exportMode'], 'static_entities')
        self.assertEqual(report['staticEntities'], 1)
        self.assertEqual(report['dynamicEntities'], 0)
        self.assertEqual(report['checks']['parents'], 0)
        self.assertEqual(report['visibleObjects'], 1)

    def test_sample_project_embodies_both_branches(self):
        sample_path = ROOT / 'examples' / '历史链验证.starscene.json'
        scene = json.loads(sample_path.read_text('utf8'))
        objects, blocked = flatten(scene, self.catalog)
        # Sample keeps one visible unbound object -> blocked as documented.
        self.assertTrue(any(b['assetId'] == 'terrain-local-unbound' for b in blocked))
        # Hiding every unbound node clears the block without guessing ids.
        for n in scene['nodes']:
            if n['assetId'] == 'terrain-local-unbound':
                n['visible'] = False
        objects, blocked = flatten(scene, self.catalog)
        self.assertFalse(blocked)
        self.assertTrue(objects)
        self.assertTrue(all(o['asset_id'] != 'terrain-local-unbound' for o in objects))


if __name__ == '__main__':
    unittest.main(verbosity=2)
