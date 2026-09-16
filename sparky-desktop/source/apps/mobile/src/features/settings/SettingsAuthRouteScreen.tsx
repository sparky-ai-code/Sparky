import { StackActions, useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useAccountAuth } from "../cloud/AccountAuthProvider";
import { hasCloudPublicConfig } from "../cloud/publicConfig";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("Settings"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn, user, signInEmail, signUpEmail, signOut } = useAccountAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    if (!email.trim() || password.length < 8 || (isSignUp && !name.trim())) return;
    setIsSubmitting(true);
    setError(null);
    try {
      if (isSignUp) {
        await signUpEmail(email.trim(), password, name.trim());
      } else {
        await signInEmail(email.trim(), password);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not authenticate.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <NativeStackScreenOptions options={{ title: isSignedIn ? "Account" : "Sign in" }} />
      <View collapsable={false} className="flex-1 overflow-hidden bg-sheet p-5">
        {!isLoaded ? (
          <ActivityIndicator />
        ) : isSignedIn ? (
          <View className="gap-4 rounded-[24px] bg-card p-5">
            <Text className="text-xl font-t3-bold text-foreground">{user?.name || "Sparky account"}</Text>
            <Text className="text-base text-foreground-secondary">{user?.email ?? "Signed in"}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void signOut()}
              className="min-h-[52px] items-center justify-center rounded-full bg-subtle px-5 active:opacity-70"
            >
              <Text className="font-t3-bold text-base text-foreground">Sign out</Text>
            </Pressable>
          </View>
        ) : (
          <View className="gap-4 rounded-[24px] bg-card p-5">
            <Text className="text-xl font-t3-bold text-foreground">
              {isSignUp ? "Create your Sparky account" : "Sign in to Sparky"}
            </Text>
            {isSignUp ? (
              <TextInput
                accessibilityLabel="Name"
                autoCapitalize="words"
                className="min-h-[52px] rounded-2xl border border-input-border bg-input px-4 text-base text-foreground"
                onChangeText={setName}
                placeholder="Name"
                placeholderTextColor="#8a8a8a"
                value={name}
              />
            ) : null}
            <TextInput
              accessibilityLabel="Email address"
              autoCapitalize="none"
              autoComplete="email"
              className="min-h-[52px] rounded-2xl border border-input-border bg-input px-4 text-base text-foreground"
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="Email address"
              placeholderTextColor="#8a8a8a"
              value={email}
            />
            <TextInput
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete={isSignUp ? "new-password" : "password"}
              className="min-h-[52px] rounded-2xl border border-input-border bg-input px-4 text-base text-foreground"
              onChangeText={setPassword}
              placeholder="Password (8+ characters)"
              placeholderTextColor="#8a8a8a"
              secureTextEntry
              value={password}
            />
            {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: isSubmitting }}
              disabled={isSubmitting}
              onPress={() => void submit()}
              className={cn(
                "min-h-[52px] items-center justify-center rounded-full bg-primary px-5 active:opacity-70",
                isSubmitting && "opacity-50",
              )}
            >
              {isSubmitting ? <ActivityIndicator color="#fff" /> : null}
              {!isSubmitting ? (
                <Text className="font-t3-bold text-base text-primary-foreground">
                  {isSignUp ? "Create account" : "Sign in"}
                </Text>
              ) : null}
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setIsSignUp((value) => !value)}>
              <Text className="text-center text-sm text-foreground-secondary">
                {isSignUp ? "Already have an account? Sign in" : "New to Sparky? Create an account"}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </>
  );
}
