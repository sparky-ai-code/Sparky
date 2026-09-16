import { Pressable, Text, View } from "react-native";

export function CloudWaitlistEnrollment(props: { readonly onSignIn: () => void }) {
  return (
    <View className="gap-[18px] rounded-[24px] bg-card p-5">
      <Text className="text-center font-t3-bold text-xl text-foreground">
        Your Sparky account is ready when you are
      </Text>
      <Text className="text-center font-sans text-base text-foreground-secondary">
        Sign in or create an account to connect Sparky Cloud environments and enable synced features.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={props.onSignIn}
        className="min-h-[54px] items-center justify-center rounded-full bg-primary px-5 py-3 active:opacity-70"
      >
        <Text className="font-t3-bold text-base text-primary-foreground">Continue to account</Text>
      </Pressable>
    </View>
  );
}
