# Firebase Test Lab

`.github/workflows/firebase-test-lab.yml` runs the app on one Firebase Test
Lab device through `run-firebase-test.sh`. By default it runs
`ShareAndBackgroundTest` (in `android/app/src/androidTest`), the emulator
test's scenario on a real phone: share a video in, convert it, then convert
again with the app sent to the background mid-encode. Test Lab's phones have a
current Chrome, so this covers the WebCodecs encoder, which the emulator's
Chrome is too old for. A `robo` run lets Test Lab's crawler explore instead,
which mostly shows the app launches, since the crawler can't see much inside
Chrome.

The app loads the live site, not the branch's web build.

## Setting it up

1. Create a project in the [Firebase console](https://console.firebase.google.com/).
   The free Spark plan is enough: it allows a few Test Lab runs a day.
2. In the [Google Cloud console](https://console.cloud.google.com/apis/library)
   for that project, enable the **Cloud Testing API** and the **Cloud Tool
   Results API**:
   ```sh
   gcloud services enable testing.googleapis.com toolresults.googleapis.com --project=PROJECT_ID
   ```
3. Under **IAM & Admin > Service Accounts**, create a service account (say
   `test-lab-runner`) with the **Editor** role, which is what Firebase's
   CI instructions use: Test Lab needs to write results to a storage bucket
   it creates, and the script reads them back. Keep this project for testing
   only. On the account's **Keys** tab, add a JSON key and download it.
4. In this repository's **Settings > Secrets and variables > Actions**, add a
   repository secret named `FIREBASE_SERVICE_ACCOUNT_KEY` holding the whole
   JSON file. The project ID is read from the key.

## Running it

- **Actions > Firebase Test Lab > Run workflow**, picking the branch, the
  test type and the device. `gcloud firebase test android models list` lists
  the devices; physical ones (like `oriole`, a Pixel 6) have current Chrome.
- Or label a pull request `firebase-test`. It then runs on every push to that
  PR that touches `android/`, so remove the label when done.
- Or locally, with gcloud signed in to the project:
  ```sh
  (cd android && ./gradlew assembleDebug assembleDebugAndroidTest)
  bash android/test-lab/run-firebase-test.sh
  ```

The job log ends with what the test saw (its `TestLabSmoke` log lines,
including the Chrome version and which encoder converted the video) and any
crashes. The job summary links the full report in the Firebase console, with
a video of the run; screenshots and logcat are in the job's artifact.
