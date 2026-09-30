# TrackIt Truck Filter & Idle Alert

A browser add-on (userscript) for the Command Alkon TrackIt dispatch map
(`https://trackit-eu.commandalkon.io/dispatch/Map.jsp`) that:

- **Shows only your trucks** on the map (and in on-page truck lists, once you point it at one).
- **Plays a chime** (plus an optional desktop popup) when one of your trucks turns **idle**, meaning it's heading back to base.

## Install without an extension (bookmarklet)

For computers where browser extensions are blocked.

1. Run `node tools/build-bookmarklet.mjs`. It writes `dist/install.html`, `dist/bookmarklet.txt` and `dist/bookmarklet.js`.
2. Open `dist/install.html` and drag the **🚚 My Trucks** button onto the bookmarks bar.
   Or create a bookmark by hand and paste the contents of `dist/bookmarklet.txt` as its URL.
3. Open the TrackIt map, log in and click the bookmark. Do this again each time the page is reloaded.

The bookmarklet also starts the tool inside the map's frame if TrackIt shows the map in a frame.

## Install with Tampermonkey

1. Install the **Tampermonkey** extension (Chrome, Edge, Firefox or Safari).
2. Open the Tampermonkey dashboard, choose **+** (new script), paste in the contents of
   [`trackit-truck-filter.user.js`](trackit-truck-filter.user.js) and save.
3. Open or reload the TrackIt map. A **🚚 My trucks** panel appears in the top right.

## Use

- **Pick your trucks.** Tick them in the list, or type numbers into the box (`101, 203`) and press Enter.
- **Show only my trucks on map** switches the filter on or off.
- **Click anywhere on the page once** after it loads. Browsers only allow sound after a click.
  **▶ Test sound** checks the volume. 🔔/🔕 in the header mutes alerts.
- **Desktop popup** also shows a system notification, which helps when the tab is in the background.
- Your choices are saved in this browser.

### Settings

| Setting | Meaning |
|---|---|
| Alert for | Only your trucks (default) or every truck |
| Idle pattern | Regular expression matched against the status. Default `idle`. Examples: `idle\|returning`, or a local-language word |
| Beeps | How many times the chime repeats |
| Re-alert after (s) | Minimum gap between alerts for the same truck, so a flickering status doesn't spam you |
| Truck id regex | Leave on auto unless truck numbers are misread. The first capture group becomes the id, e.g. `Truck\s+(\w+)` |
| List row selector / 🎯 Pick truck row | Click a truck in any on-page list or table. Rows for other trucks get hidden too, and their status is read |

## How it works

The script has no fixed knowledge of the TrackIt page, so it reads trucks from three places:

1. **Map markers.** Hooks Google Maps (`google.maps.Marker`, `AdvancedMarkerElement`) and Leaflet (`L.Marker`),
   reads the truck number and status from each marker's title, label, tooltip and icon file name, and takes other trucks' markers off the map.
2. **The page's live data feed.** Watches fetch/XHR responses (JSON or XML) for records that have a truck id and a status.
3. **On-page lists.** Only if you set them up with the picker.

An alert fires when a truck's status changes from something else to one matching the idle pattern.

## If it doesn't pick things up

Open **Diagnostics → Copy diagnostics** and send the text over. It shows which map library was found, sample
marker titles and icon names, and the shape of the data feed, which is enough to tune the script. If truck
statuses show as `icon:truck_yellow.png`, the status comes only from the icon colour. In that case set
**Idle pattern** to that name (e.g. `yellow`).

## Development

`node test/run.mjs` runs a headless Chromium test against a mock map page (`test/mock-map.html`) that
has a stubbed Google Maps API, a JSON truck feed and a truck table. Needs Playwright.
`node test/bookmarklet.mjs` tests the bookmarklet build, started after the page loads, on the page itself and inside a frame.
