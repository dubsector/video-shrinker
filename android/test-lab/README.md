# Firebase Test Lab

`.github/workflows/firebase-test-lab.yml` runs the app on one Firebase Test
Lab device through `run-firebase-test.sh`. By default it runs
`ShareAndBackgroundTest` (in `android/app/src/androidTest`), the emulator
test's scenario on a real phone: share a video in, convert it, then convert
again with the app sent to the background mid-encode. The emulator has no
hardware video encoder, so the app always falls back to ffmpeg.wasm there.
Test Lab's physical phones have one, and the test fails unless both
conversions used WebCodecs on it (the `engine` input loosens that to any
WebCodecs, or to anything). It refuses to run on virtual devices (unless only the share tests run), which have
no hardware encoder either.

`ShareSourcesTest` shares a video the ways real shares arrive, which the
emulator test can't (its shell can't hand another app a gallery item): from
the system media store, from a provider that acts like Google Photos at its
most awkward (no file extension, size or type, streaming slowly), and from
Google Photos itself through its Share button, on phones that have it. Each
must reach the web app. The Photos one is skipped, not failed, when Photos
is missing or its screens can't be got through. The `tests` input runs just
one of the two classes. A `robo` run lets Test Lab's crawler explore instead,
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
3. Under **IAM & Admin > Service Accounts**, pick the account the workflow
   acts as (a new `test-lab-runner`, or the project's
   `firebase-adminsdk-…` account) and give it the **Editor** role, which is
   what Firebase's CI instructions use: Test Lab writes results to a storage
   bucket it creates, and the script uploads the APKs there and reads the
   results back. Keep this project for testing only.
4. Let the workflow sign in as that account. Either:
   - **Without a key (preferred):** set up Workload Identity Federation, so
     GitHub's short-lived OIDC token is swapped for Google credentials and no
     key is stored anywhere:
     ```sh
     gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project=PROJECT_ID
     gcloud iam workload-identity-pools create github --location=global --project=PROJECT_ID
     gcloud iam workload-identity-pools providers create-oidc video-shrinker \
       --location=global --workload-identity-pool=github --project=PROJECT_ID \
       --issuer-uri=https://token.actions.githubusercontent.com \
       --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
       --attribute-condition="assertion.repository == 'dubsector/video-shrinker'"
     gcloud iam service-accounts add-iam-policy-binding SERVICE_ACCOUNT_EMAIL --project=PROJECT_ID \
       --role=roles/iam.workloadIdentityUser \
       --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/dubsector/video-shrinker"
     ```
     Then, under this repository's **Settings > Secrets and variables >
     Actions > Variables**, add `GCP_WORKLOAD_IDENTITY_PROVIDER` set to
     `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/video-shrinker`
     and `GCP_SERVICE_ACCOUNT` set to the account's email. The attribute
     condition keeps any other repository from using the pool.
   - **With a key:** on the account's **Keys** tab, add a JSON key, and add
     it whole as a repository secret named `FIREBASE_SERVICE_ACCOUNT_KEY`.
     The project ID is read from the key.

   When both are set, the workflow uses Workload Identity Federation.
5. Optionally, keep results in a bucket of your own by setting a
   `TEST_LAB_RESULTS_BUCKET` variable (say `gs://video-shrinker-test-results`)
   and granting the account **Storage Object Admin** on it. Test Lab only
   accepts a bucket of your own on a project with billing turned on, so on the
   free Spark plan leave this unset and Test Lab's own bucket is used.

## Running it

- **Actions > Firebase Test Lab > Run workflow**, picking the branch, the
  test type and the device. `gcloud firebase test android models list` lists
  the devices. The default is a Pixel 9 Pro XL (`komodo`) on Android 15.
  Older devices' Chrome isn't always current: the Pixel 6 (`oriole`) on
  Android 13 had Chrome 109. Each run uses one of the day's free runs, so the
  workflow never starts on its own.
- Or locally, with gcloud signed in to the project:
  ```sh
  (cd android && ./gradlew assembleDebug assembleDebugAndroidTest)
  bash android/test-lab/run-firebase-test.sh
  ```

The job log ends with what the test saw (its `TestLabSmoke` log lines,
including the Chrome version and which encoder converted the video) and any
crashes. The job summary links the full report in the Firebase console, with
a video of the run; screenshots and logcat are in the job's artifact.
