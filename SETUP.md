# Setting up Paper Lab on your computer

This takes about 10 minutes the first time. You only do steps 1 and 2 once.

Paper Lab is practice only. It never touches a wallet or real money.

## Step 1: Install Node (one time)

Node is the free program that runs Paper Lab.

1. Go to **https://nodejs.org**
2. Click the big green button for the **LTS** version and download it.
3. Open the downloaded file and click through the installer, accepting the defaults.

## Step 2: Download Paper Lab (one time)

1. Make sure you're signed in to GitHub in your browser.
2. Open this link. It downloads a ZIP file:
   **https://github.com/Aptyll/Tool/archive/refs/heads/claude/project-thread-uhhaqy.zip**
3. Double-click the ZIP to unzip it. You get a folder named something like `Tool-claude-project-thread-uhhaqy`.
4. Move that folder somewhere easy to find, like your Desktop or Documents.

## Step 3: Start it

### On a Mac

1. Press **Cmd + Space**, type **Terminal**, and press Enter. A window with text appears.
2. Type `cd ` (the letters c and d, then a space). Don't press Enter yet.
3. Drag the Paper Lab folder from Finder into the Terminal window. Its location appears after `cd `. Now press Enter.
4. Type `npm start` and press Enter.

### On Windows

1. Open the Paper Lab folder in File Explorer.
2. Click the address bar at the top of the window (where the folder path is shown), type `cmd`, and press Enter. A black window opens, already in the right folder.
3. Type `npm start` and press Enter.
4. If Windows asks about network access, click **Allow**. Paper Lab only listens on your own computer.

When it's working, you'll see a line like:

```
Paper lab on http://localhost:4317
```

Leave this window open. Closing it stops Paper Lab.

## Step 4: Open the dashboard

In your browser, go to **http://localhost:4317**

The first prices appear within a minute. Trades start opening as soon as a rule fires.

## Stopping and starting again

- **To stop:** click the Terminal (or black) window and press **Ctrl + C**.
- **To start again later:** repeat Step 3. Your trades and history are saved and pick up where you left off.

## Trying it with fake data

To see how it works without the internet, use `npm run demo` instead of `npm start` in Step 3. Demo data is kept separate, so it never mixes with real results.

## If something goes wrong

- **"command not found" or "npm is not recognized":** Node isn't installed, or the window was opened before installing it. Close the window, do Step 1 again, then open a new window.
- **"Node 22.13 or newer" error, or an error mentioning `node:sqlite`:** your Node is too old. Install the current LTS version from nodejs.org.
- **"address already in use":** Paper Lab is already running in another window. Use that one, or close it first.
- **The page shows "poll failed":** the internet connection or the data source had a hiccup. It retries automatically every minute.
- **Anything else:** copy the text from the window and send it to Claude in the project thread.
