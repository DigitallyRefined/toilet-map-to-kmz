"""Load a Toilet Map KMZ into QGIS and colour it by category.

QGIS builds a layer's symbology itself, so the reliable way to get the six
category colours is to let QGIS create them. Run this from the QGIS Python
Console, with the .kmz already downloaded anywhere:

    exec(open("qgis/apply-category-style.py").read())

The script finds the file, adds it to the project, applies a categorised
renderer on the `category` field, prints how many features matched each value,
and saves a .qml beside the .kmz so QGIS loads the colours automatically next
time. If QGIS will not open the .kmz directly, the KML is extracted from it
with Python's zipfile module and that is loaded instead.

Everything lives in one function on purpose: when this file is exec()'d rather
than imported, names defined at the top level go into a local namespace that
functions cannot see, so module-level helpers and constants would not resolve.
"""


def apply_toilet_map_style():
    import json
    import os
    import tempfile
    import traceback
    import xml.etree.ElementTree as ElementTree
    import zipfile
    from collections import Counter

    from qgis.core import (
        QgsCategorizedSymbolRenderer,
        QgsMarkerSymbol,
        QgsProject,
        QgsRendererCategory,
        QgsVectorLayer,
    )

    # Set this to an absolute path if the .kmz is not found automatically.
    toilet_file = ""

    # Keep in step with CATEGORY_LABELS and PLACEMARK_COLOURS in toilet-map-to-kmz.mjs.
    categories = [
        ("Free, gender/urinal restricted", "#00a58c"),
        ("Free, wheelchair accessible", "#0066cc"),
        ("Free", "#3c8c3c"),
        ("Not free, gender/urinal restricted", "#ff9600"),
        ("Not free, wheelchair accessible", "#ffc800"),
        ("Not free", "#e51b23"),
    ]
    category_field = "category"
    marker_size = "2.2"  # millimetres
    outline_colour = "35,35,35,255"
    suffixes = (".kmz", ".kml")

    def rgba(colour):
        """'#00a58c' -> '0,165,140,255', the form QGIS expects."""
        value = colour.lstrip("#")
        red, green, blue = (int(value[index:index + 2], 16) for index in (0, 2, 4))
        return f"{red},{green},{blue},255"

    def report(lines, title):
        """Print to the Python Console and show in the QGIS message bar."""
        for line in lines:
            print(line)
        try:
            from qgis.utils import iface

            iface.messageBar().pushMessage(title, lines[0], level=0, duration=10)
        except Exception:
            pass  # not running inside the QGIS GUI, console output is enough

    def base_name(path):
        return os.path.splitext(os.path.basename(path))[0]

    def find_candidates():
        """Data files to try: in-project layers, then the filesystem."""
        found = []

        for layer in QgsProject.instance().mapLayers().values():
            if isinstance(layer, QgsVectorLayer):
                source = str(layer.source())
                if source.lower().endswith(suffixes):
                    found.append(source)

        if toilet_file:
            found.append(os.path.expanduser(toilet_file))

        # __file__ is undefined when this file is exec()'d, so fall back to the
        # project folder, the user's downloads folder and the working directory.
        search_dirs = []
        try:
            search_dirs.append(os.path.dirname(os.path.abspath(__file__)))
        except NameError:
            pass
        project_home = QgsProject.instance().homePath()
        if project_home:
            search_dirs.append(project_home)
        search_dirs.append(os.path.expanduser("~/Downloads"))
        search_dirs.append(os.getcwd())

        for directory in search_dirs:
            try:
                entries = os.listdir(directory)
            except OSError:
                continue
            matches = [
                os.path.join(directory, entry)
                for entry in entries
                if entry.lower().endswith(suffixes) and entry.lower().startswith("toilets")
            ]
            # Newest first, so a fresh export wins over an older download.
            matches.sort(key=lambda path: os.path.getmtime(path), reverse=True)
            found.extend(matches)

        seen = set()
        unique = []
        for path in found:
            key = os.path.normcase(os.path.abspath(path))
            if key not in seen:
                seen.add(key)
                unique.append(path)
        # Try .kmz before .kml, and dedupe by base name so a .kml sitting next
        # to its .kmz is not tried twice.
        unique.sort(key=lambda path: 0 if path.lower().endswith(".kmz") else 1)
        return unique

    def already_loaded(path):
        """The project's own layer for this file, if the user added it first."""
        key = os.path.normcase(os.path.abspath(path))
        for candidate in QgsProject.instance().mapLayers().values():
            if isinstance(candidate, QgsVectorLayer):
                source = str(candidate.source())
                if os.path.normcase(os.path.abspath(source)) == key:
                    return candidate
        return None

    def load_directly(path):
        """Try to open the file as-is. Returns the layer, or None plus the reason."""
        if not os.path.exists(path):
            return None, "file not found"
        layer = QgsVectorLayer(path, base_name(path), "ogr")
        if layer.isValid():
            return layer, ""
        message = layer.error().message() if hasattr(layer, "error") else ""
        return None, message or "QGIS reported the source as invalid"

    def extract_kml(kmz_path):
        """Pull the KML out of the KMZ so QGIS can open that instead."""
        try:
            with zipfile.ZipFile(kmz_path) as archive:
                entries = [
                    name for name in archive.namelist() if name.lower().endswith(".kml")
                ]
                if not entries:
                    return None, "no .kml inside the archive"
                entry = min(entries, key=lambda name: len(name))
                target_dir = tempfile.mkdtemp(prefix="toilet-map-")
                # Name the copy after the .kmz, not after doc.kml: QGIS names the
                # layer after the file, and a .qml is only auto-loaded when its
                # name matches that layer name.
                target = os.path.join(
                    target_dir, os.path.splitext(os.path.basename(kmz_path))[0] + ".kml"
                )
                with archive.open(entry) as source, open(target, "wb") as destination:
                    destination.write(source.read())
            return target, ""
        except Exception as error:  # noqa: BLE001 - report anything the zip throws
            return None, f"{type(error).__name__}: {error}"

    def field_names(layer):
        return [field.name() for field in layer.fields()]

    def save_style(layer, target):
        """Write the .qml. The method for this is not the same on every QGIS.

        QGIS 4 dropped QgsMapLayer.saveStyleToFile; saveNamedStyle exists in both
        3.x and 4.x. Rather than pin a version, try what this build has and trust
        the file on disk over the return value, which some versions report wrongly.
        """
        if os.path.exists(target):
            os.remove(target)
        for name in ("saveNamedStyle", "saveStyleToFile", "saveStyle"):
            method = getattr(layer, name, None)
            if not callable(method):
                continue
            try:
                result = method(target)
            except TypeError:
                continue  # wrong signature for this build, try the next name
            except Exception as error:  # noqa: BLE001
                return False, f"{name}() raised {type(error).__name__}: {error}"
            if os.path.exists(target):
                return True, name
            return False, f"{name}() returned {result!r} but wrote no file"
        return False, "this QGIS build has no method to save a .qml"

    def read_attributes(element, namespace):
        """Every ExtendedData value on a placemark, whichever form it uses."""
        values = {}
        for node in element.iter():
            if node.tag == namespace + "SimpleData":
                name = node.get("name")
                if name:
                    values[name] = node.text or ""
            elif node.tag == namespace + "Data":
                name = node.get("name")
                child = node.find(namespace + "value")
                if name and name not in values and child is not None:
                    values[name] = child.text or ""
        return values

    def as_json_value(value):
        """Keep booleans and numbers typed, so QGIS sorts and filters them."""
        if not value:
            return None  # the dataset uses null for "not recorded"
        if value.lower() in ("true", "false"):
            return value.lower() == "true"
        try:
            if str(int(value)) == value:
                return int(value)
            return float(value)
        except ValueError:
            return value

    def parse_placemarks(kml_path):
        """Read the KML ourselves: OGR does not always expose ExtendedData."""
        namespace = "{http://www.opengis.net/kml/2.2}"
        records = []
        for _event, element in ElementTree.iterparse(kml_path, events=("end",)):
            if element.tag != namespace + "Placemark":
                continue
            coordinates = element.findtext(f".//{namespace}coordinates") or ""
            parts = coordinates.split(",")
            try:
                longitude, latitude = float(parts[0]), float(parts[1])
            except (IndexError, ValueError):
                element.clear()
                continue
            records.append(
                {
                    "Name": element.findtext(f"{namespace}name") or "",
                    "Description": element.findtext(f"{namespace}description") or "",
                    "attributes": read_attributes(element, namespace),
                    "longitude": longitude,
                    "latitude": latitude,
                }
            )
            element.clear()  # do not hold the whole tree in memory
        return records

    def layer_from_geojson(source_file):
        """Rebuild the layer as GeoJSON, which OGR reads reliably.

        Only used when QGIS opens the file but leaves the attributes out of the
        attribute table, which some builds do with KML ExtendedData. Every field
        the file carries is passed through, not just the category.
        """
        kml_path = source_file
        if kml_path.lower().endswith(".kmz"):
            kml_path, why = extract_kml(kml_path)
            if kml_path is None:
                return None, why
        records = parse_placemarks(kml_path)
        if not records:
            return None, "no placemarks with coordinates in the KML"
        collection = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "Name": record["Name"],
                        "Description": record["Description"],
                        **{
                            field: as_json_value(value)
                            for field, value in record["attributes"].items()
                        },
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": [record["longitude"], record["latitude"]],
                    },
                }
                for record in records
            ],
        }
        geojson_path = os.path.join(
            os.path.dirname(kml_path), base_name(source_file) + ".geojson"
        )
        with open(geojson_path, "w", encoding="utf-8") as handle:
            json.dump(collection, handle, ensure_ascii=False)
        layer = QgsVectorLayer(geojson_path, base_name(source_file), "ogr")
        if not layer.isValid():
            return None, layer.error().message() or "QGIS would not open the GeoJSON"
        if category_field not in field_names(layer):
            return None, f"the GeoJSON layer has no {category_field} field"
        return layer, ""

    print("Toilet Map category style: starting")

    candidates = find_candidates()
    if not candidates:
        report(
            [
                "No toilets-*.kmz or toilets-*.kml found.",
                "Searched the QGIS project folder, ~/Downloads and the working",
                "directory, plus any KMZ already in the project.",
                f"Set toilet_file at the top of the script to the full path, e.g.",
                f"  toilet_file = {os.path.expanduser('~/Downloads/toilets-2026-09-27.kmz')!r}",
            ],
            "Toilet Map style",
        )
        return

    print(f"Found {len(candidates)} candidate file(s):")
    for path in candidates:
        print(f"  {path}")

    layer = None
    in_project = False
    failures = []
    first_kmz = next((path for path in candidates if path.lower().endswith(".kmz")), None)

    for path in candidates:
        loaded = already_loaded(path)
        if loaded is not None:
            print(f"Using the layer already in the project for {path}")
            layer = loaded
            in_project = True
            break
        print(f"Trying {path}")
        candidate, reason = load_directly(path)
        if candidate is not None:
            layer = candidate
            print("  opened directly")
            break
        print(f"  failed: {reason}")
        failures.append((path, reason))

    if layer is None and first_kmz:
        # QGIS would not take the .kmz, so fall back on the KML inside it.
        print(f"Extracting the KML out of {first_kmz}")
        extracted, why = extract_kml(first_kmz)
        if extracted is None:
            print(f"  could not extract: {why}")
            failures.append((first_kmz, why))
        else:
            print(f"  extracted to {extracted}")
            layer, reason = load_directly(extracted)
            if layer is not None:
                print("  opened the extracted KML")
            else:
                print(f"  failed: {reason}")
                failures.append((extracted, reason))

    if layer is None:
        report(
            ["QGIS would not open any of the files above."]
            + [f"  {path}: {reason}" for path, reason in failures],
            "Toilet Map style",
        )
        return

    fields = field_names(layer)
    print(f"Fields: {', '.join(fields) if fields else '(none)'}")

    if category_field not in fields:
        # QGIS opened the file but dropped the KML ExtendedData attribute, which
        # some builds do. Read the KML here and hand OGR a GeoJSON instead.
        source_file = first_kmz or candidates[0]
        print(f"QGIS did not expose the {category_field} field, so reading the KML directly")
        rebuilt, why = layer_from_geojson(source_file)
        if rebuilt is None:
            report(
                [
                    f"{layer.name()!r} has no {category_field!r} field, and rebuilding it",
                    f"as GeoJSON failed: {why}",
                    "Re-run node toilet-map-to-kmz.mjs to regenerate the file, then",
                    "run this script again.",
                ],
                "Toilet Map style",
            )
            return
        print(f"  rebuilt {rebuilt.featureCount()} features as GeoJSON and loaded that")
        layer = rebuilt
        fields = field_names(layer)
        in_project = False  # a new layer, so it still has to be added below
        print(f"Fields: {', '.join(fields)}")

    if not in_project:
        QgsProject.instance().addMapLayer(layer)
        print(f"Added layer {layer.name()!r} to the project")

    renderer_categories = []
    for value, colour in categories:
        symbol = QgsMarkerSymbol.createSimple(
            {
                "name": "circle",
                "color": rgba(colour),
                "outline_color": outline_colour,
                "outline_style": "solid",
                "outline_width": "0.2",
                "size": marker_size,
            }
        )
        renderer_categories.append(QgsRendererCategory(value, symbol, value))

    layer.setRenderer(QgsCategorizedSymbolRenderer(category_field, renderer_categories))
    layer.triggerRepaint()
    print("Renderer applied")

    # Count matches in a single pass, so a wrong or stale field shows up as
    # numbers here rather than silently rendering one flat colour.
    counts = Counter(feature[category_field] for feature in layer.getFeatures())
    total = sum(counts.get(value, 0) for value, _colour in categories)
    empty = [value for value, _colour in categories if not counts.get(value)]

    lines = [f"{layer.name()}: {total} of {layer.featureCount()} features matched"]
    lines.extend(
        f"  {counts.get(value, 0):>6}  {value}" for value, _colour in categories
    )
    if empty:
        lines.append("No features matched: " + ", ".join(empty))
    else:
        lines.append("All six categories matched.")
    report(lines, "Toilet Map style")

    # Save the style beside the .kmz when we have one: the KML document is named
    # after it, so the layer name matches the .qml and QGIS auto-loads it.
    style_target = ""
    if first_kmz and os.path.exists(first_kmz):
        style_target = first_kmz[: -len(".kmz")] + ".qml"
    else:
        source = str(layer.source())
        if source.lower().endswith(suffixes):
            style_target = os.path.splitext(source)[0] + ".qml"

    if not style_target:
        report(
            ["No file to write a .qml beside, so the colours are only in this session."],
            "Toilet Map style",
        )
        return

    saved, detail = save_style(layer, style_target)
    if saved:
        report(
            [
                f"Saved style to {style_target} with {detail}(), loaded automatically",
                "next time that file is opened.",
            ],
            "Toilet Map style",
        )
    else:
        report(
            [
                f"Could not save the style: {detail}",
                "The colours are applied in this session. To keep them, use",
                "*Layer Properties > Style > Save Style...* and save a .qml next to",
                "your .kmz with the same base name.",
            ],
            "Toilet Map style",
        )


try:
    apply_toilet_map_style()
except Exception:
    import traceback

    traceback.print_exc()
